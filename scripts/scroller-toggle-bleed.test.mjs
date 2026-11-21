// The vendored toggles (Checkbox, Radio, Switch) draw an enlarged hit area, an
// `after:-inset-y-2` pseudo that overhangs their box by 8px. A scroller whose
// content ends in a toggle with less than 8px of bottom slack overflows by that
// overhang and shows a scrollbar with nothing to scroll. Scope contract:
// G1  dialog-scroll.ts exports DIALOG_SCROLL and DIALOG_SCROLL_X_HIDDEN, each a
//     single string literal carrying `pb-N` and `-mb-N` (one N >= 2) and no other
//     p-/py-/pb-/m-/my-/mb- token of either sign.
// G2  every other reference to either name in src/ is a direct argument of a
//     `cn(` call (or the whole `className={…}` expression), and that call's
//     literal tokens carry no p-/py-/pb- token and no m-/my-/mb- token of either
//     sign but exactly `mb-0` (the opt-out for a stretched flex-row scroller);
//     the logical-block `pbe-` / `mbe-` spellings count as the same override.
// G3  every other .tsx scroller (an opening tag whose literal tokens include
//     overflow-auto / overflow-y-auto / overflow-scroll / overflow-y-scroll) is
//     flagged when a toggle (Checkbox, Radio, Switch, HeldSwitch, CheckboxField;
//     a dotted name matches on its last segment) sits ANYWHERE between its
//     opening tag and its matching close, a nested scroller's range included,
//     unless its effective bottom padding is >= 8px (N, px, [Npx], [Nrem];
//     unreadable counts as unpadded). cn( drops earlier conflicts as
//     tailwind-merge does; then pb/pbe beat py beat p, and two values at one
//     level (stylesheet order) or a variant/important (`!x`, `x!`) token under
//     8px fail closed. The rule over-flags by design: whether the toggle can
//     render last is not modelled, so the remedy for a flag is the padding or
//     a reviewed ALLOWLIST row.
// G4  the vendored files holding `after:-inset` are exactly checkbox, radio-
//     group and switch; each one's root `className={…}` expression, whitespace
//     collapsed, is exactly `cn("<ROOT_PINS string>", className)`, since any
//     other class can move the overhang the 8px floor mirrors; HeldSwitch and
//     CheckboxField still import their primitive; an aliased or namespace
//     import of a toggle or a constant fails.
// G5  flagged scrollers a reviewed file keeps sit in ALLOWLIST with a count; a
//     count that drifts either way, or an entry with no flag, fails. A new
//     reviewed row also raises the allowlist's exact-size assertion below.
// G6  a ScanError anywhere fails, and so do zero files, zero literal scrollers
//     or zero constant call sites.
// Scope contract: the guard models literal class strings and a lone `cn()`
// with tailwind-merge's conflict rules plus the cascade. Out of contract by
// design, reviewed by hand rather than extended here: scroller or padding
// classes from constants, props or template strings; conditional `cn()` arms
// (`cond && "pb-2"` counts as present, so such a scroller is missed rather
// than flagged); an important padding utility (`pb-2!`) on a scroller fails
// closed even at >= 8px (remedy: drop the `!` or add an allowlist row);
// stylesheet rules; escaped delimiters inside arbitrary
// variants; logical properties (pbe) under a non-default writing mode; an
// element with only overflow-x-* (its y axis computes to auto, but it is not
// read as a scroller). Also out of sight: a toggle rendered by a child
// component outside the toggle set; a call-site className on a toggle that
// moves its hit area (census at the time of writing: 0 of 139 toggle tags carry
// an after:/before: token); the vendored child parts (Indicator, Thumb);
// padding a component adds by default (DialogContent's p-4) and row padding
// around the toggle (both can make a flagged site safe: allowlist it); Base UI
// ScrollArea / ConversationScrollArea viewports (census at the time of
// writing: 0 of 38 render a toggle in their own JSX; the three hosts whose
// child components render toggles pad their content: SettingsScreen `p-6`,
// TagDetailView and PrReviewPanel `p-4`); the right-edge overhang (no site:
// right-aligned Switches sit in X_HIDDEN scrollers); and layout neutrality
// beyond G2's margin rule. The toggle set's bound: `git grep "after:-inset" --
// src/components/ui` hits exactly checkbox, radio-group and switch (tabs.tsx's
// underline is `after:inset-x-0`, no hit area). The toggle importers outside
// ui/ number 57 files; the four under src/components are the two wrappers plus
// user-picker-body.tsx (its scroller pads itself `py-2`) and
// confirm-dialog-host.tsx, which render the primitive directly and whose
// scrollers G3 reads like any other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSE,
  escapeRe,
  lineOf,
  literalText,
  loadCorpus,
  maskNonCode,
  matchBrace,
  OPEN,
  ScanError,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEF = "src/components/dialog-scroll.ts";
const VENDORED = "src/components/ui/";
const NAMES = ["DIALOG_SCROLL", "DIALOG_SCROLL_X_HIDDEN"];
const NAME_RE = /\bDIALOG_SCROLL(?:_X_HIDDEN)?\b/g;
const TOGGLES = new Set([
  "Checkbox",
  "Radio",
  "Switch",
  "HeldSwitch",
  "CheckboxField",
]);
const TOGGLE_UI = [
  "src/components/ui/checkbox.tsx",
  "src/components/ui/radio-group.tsx",
  "src/components/ui/switch.tsx",
];
/** Each vendored toggle's root and its whole class literal, copied from the
 *  file: the 8px floor mirrors the hit area these classes draw. */
const ROOT_PINS = {
  "src/components/ui/checkbox.tsx": [
    "CheckboxPrimitive.Root",
    "peer relative flex size-4 shrink-0 items-center justify-center rounded-none border border-input transition-colors outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
  ],
  "src/components/ui/radio-group.tsx": [
    "RadioPrimitive.Root",
    "relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 data-checked:border-primary",
  ],
  "src/components/ui/switch.tsx": [
    "SwitchPrimitive.Root",
    "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
  ],
};
const TOGGLE_MODULES =
  /^@\/components\/(?:ui\/(?:checkbox|radio-group|switch)|held-switch)$/;
const WRAPPERS = {
  "src/components/held-switch.tsx": "@/components/ui/switch",
  "src/components/form/fields.tsx": "@/components/ui/checkbox",
};

const ALLOWLIST = {
  "src/features/settings/mcp/McpServerDialog.tsx": {
    count: 1,
    rationale:
      "the last child is the Enabled label row (border px-3 py-2 items-center): ~36px of text beside an 18.4px Switch leaves ~17.8px under the switch box, so the 8px overhang stays ~10px inside the row",
  },
  "src/features/settings/mcp/ImportMcpDialog.tsx": {
    count: 1,
    rationale:
      "each mapped candidate row's wrapper is overflow-hidden rounded-md border, which clips the Checkbox's ::after before it reaches the scroller",
  },
  "src/features/scripts/TaskDialog.tsx": {
    count: 1,
    rationale:
      "the scroller is DialogContent itself, whose vendored p-4 (src/components/ui/dialog.tsx) gives 16px of bottom padding",
  },
};

const SPACING = /^-?(?:p|py|pb|pbe|m|my|mb|mbe)-/;
const SCROLL = /^overflow-(?:y-)?(?:auto|scroll)$/;
const TAG = /<[A-Za-z][\w.]*/g;

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
const bare = (tok) => parseToken(tok).base;
const tokensOf = (literal) => literal.split(/\s+/).filter(Boolean);
const mask = (rel, text) => maskNonCode(text, rel.endsWith(".tsx"));

function prevNonSpace(masked, i) {
  while (i >= 0 && /\s/.test(masked[i])) i--;
  return i;
}
function nextNonSpace(masked, i) {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

/** Whether a `<Name` at `i` sits where JSX can start, so `a<b` and a generic's
 *  `<T>` are not read as tags. */
function jsxPosition(masked, i) {
  const p = prevNonSpace(masked, i - 1);
  if (p < 0) return true;
  if ("({}>?:&|=,[".includes(masked[p])) return true;
  return /\breturn$/.test(masked.slice(Math.max(0, p - 6), p + 1));
}

/** Every JSX opening tag in [from, to) as `{ s, e, name }`, e just past `>`. */
function tagsIn(rel, text, masked, from, to) {
  const out = [];
  const re = new RegExp(TAG.source, "g");
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    if (!jsxPosition(masked, m.index)) continue;
    const end = tagEnd(masked, m.index);
    if (end < 0 || end >= to) {
      throw new ScanError(`${rel}:${lineOf(text, m.index)}: tag never ends`);
    }
    out.push({ s: m.index, e: end + 1, name: m[0].slice(1) });
  }
  return out;
}

/** The element whose opening tag is [s, e): `close` is where its closing tag
 *  starts (e for a self-closing tag), `end` is just past it. */
function elementBounds(rel, text, masked, s, e, name) {
  if (masked[e - 2] === "/") return { close: e, end: e };
  const either = new RegExp(`<(/?)${escapeRe(name)}(?![\\w.$-])`, "g");
  either.lastIndex = e;
  let depth = 1;
  for (;;) {
    const n = either.exec(masked);
    if (!n) {
      throw new ScanError(`${rel}:${lineOf(text, s)}: <${name} has no close`);
    }
    if (n[1]) {
      if (--depth === 0) {
        const end = masked.indexOf(">", n.index);
        if (end < 0) throw new ScanError(`${rel}: </${name} never ends`);
        return { close: n.index, end: end + 1 };
      }
    } else {
      const t = tagEnd(masked, n.index);
      if (t < 0) {
        throw new ScanError(`${rel}:${lineOf(text, n.index)}: tag never ends`);
      }
      if (masked[t - 1] !== "/") depth++;
    }
  }
}

/** A bottom-padding value in px: N (N×4), `px`, `[Npx]`, `[Nrem]`; NaN when
 *  unreadable, which never counts as padded. */
function paddingPx(value) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 4;
  if (value === "px") return 1;
  const m = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(value);
  if (m) return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
  return Number.NaN;
}

/** One property axis over a class list (header G3's model). `classify(base)`
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

const BOTTOM_LEVEL = { p: 0, py: 1, pb: 2, pbe: 2 };

/** Whether a class value's effective bottom padding is at least 8px. */
function padded(cls) {
  const r = resolveAxis(cls, (base) => {
    const m = /^(p|py|pb|pbe)-(.+)$/.exec(base);
    return (
      m && { level: BOTTOM_LEVEL[m[1]], prop: m[1], value: paddingPx(m[2]) }
    );
  });
  return !r.ambiguous && r.value >= 8 && r.overrides.every((px) => px >= 8);
}

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

/** The `className` tokens on the opening tag [s, e), and whether they merge
 *  as one `className={cn(…)}` call (tailwind-merge) or stand as written. */
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
  return { tokens: tokensOf(out.join(" ")), merged: values === 1 && merged };
}

/** G1: the two constants' own bottom pair. */
export function constantProblems(files) {
  const text = files.get(DEF);
  if (text === undefined) return [`${DEF}: G1 the definition file is missing`];
  const masked = maskNonCode(text, false);
  const out = [];
  for (const name of NAMES) {
    const m = new RegExp(`\\bexport const ${name}\\s*=\\s*`).exec(masked);
    if (!m) {
      out.push(`${DEF}: G1 ${name} is not an exported const`);
      continue;
    }
    const line = lineOf(text, m.index);
    const q = m.index + m[0].length;
    const quote = masked[q];
    const close =
      quote === '"' || quote === "'" ? masked.indexOf(quote, q + 1) : -1;
    if (close < 0 || !/^\s*;/.test(masked.slice(close + 1))) {
      out.push(`${DEF}:${line}: G1 ${name} is not a single string literal`);
      continue;
    }
    const tokens = tokensOf(text.slice(q + 1, close));
    const spacing = tokens.filter((t) => SPACING.test(bare(t)));
    const n = /^pb-(\d+(?:\.\d+)?)$/.exec(
      tokens.find((t) => t.startsWith("pb-")) ?? "",
    )?.[1];
    const ok =
      n !== undefined &&
      Number(n) >= 2 &&
      spacing.length === 2 &&
      tokens.includes(`pb-${n}`) &&
      tokens.includes(`-mb-${n}`);
    if (!ok) {
      out.push(
        `${DEF}:${line}: G1 ${name} must carry pb-N and -mb-N (one N >= 2) and no other p-/py-/pb-/m-/my-/mb- token`,
      );
    }
  }
  return out;
}

/** Import and re-export statements with a module specifier, as
 *  `{ from, to, specifiers, namespace, module }`. */
function importsOf(text, masked) {
  const re =
    /\b(?:import|export)\s+(?:type\s+)?(\*\s*as\s+[\w$]+|\*|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*(["'])/g;
  const out = [];
  for (const m of masked.matchAll(re)) {
    const q = m.index + m[0].length - 1;
    const end = masked.indexOf(m[2], q + 1);
    const braces = /\{([^}]*)\}/.exec(m[1]);
    out.push({
      from: m.index,
      to: end + 1,
      specifiers: braces ? braces[1] : "",
      namespace: m[1].includes("*"),
      module: text.slice(q + 1, end),
    });
  }
  return out;
}

/** G2 and G4's import arms over one file; returns the constant call sites. */
function referenceProblems(rel, text, masked, out) {
  const imports = importsOf(text, masked);
  for (const imp of imports) {
    for (const raw of imp.specifiers.split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      const alias = /^([\w$]+)\s+as\s+[\w$]+$/.exec(spec);
      if (alias && NAMES.includes(alias[1])) {
        out.push(
          `${rel}:${lineOf(text, imp.from)}: G2 aliased import of ${alias[1]}`,
        );
      }
      // A vendored file aliasing Base UI's own export is not an app toggle.
      const app = imp.module.startsWith("@/") || imp.module.startsWith(".");
      if (app && alias && TOGGLES.has(alias[1])) {
        out.push(
          `${rel}:${lineOf(text, imp.from)}: G4 aliased import of ${alias[1]}`,
        );
      }
    }
    if (imp.namespace && /dialog-scroll$/.test(imp.module)) {
      out.push(
        `${rel}:${lineOf(text, imp.from)}: G2 namespace import of ${imp.module}`,
      );
    }
    if (imp.namespace && TOGGLE_MODULES.test(imp.module)) {
      out.push(
        `${rel}:${lineOf(text, imp.from)}: G4 namespace import of ${imp.module}`,
      );
    }
  }
  if (rel === DEF) return 0;
  let sites = 0;
  for (const m of masked.matchAll(NAME_RE)) {
    const i = m.index;
    if (imports.some((imp) => i >= imp.from && i < imp.to)) continue;
    const line = lineOf(text, i);
    const prev = prevNonSpace(masked, i - 1);
    const next = nextNonSpace(masked, i + m[0].length);
    if (
      masked[prev] === "{" &&
      masked[next] === "}" &&
      /className\s*=\s*$/.test(masked.slice(Math.max(0, prev - 20), prev))
    ) {
      sites++;
      continue;
    }
    let open = -1;
    if ("(,".includes(masked[prev]) && ",)".includes(masked[next])) {
      let depth = 0;
      for (let k = i - 1; k >= 0; k--) {
        if (CLOSE.has(masked[k])) depth++;
        else if (OPEN.has(masked[k])) {
          if (depth === 0) {
            if (masked[k] === "(") open = k;
            break;
          }
          depth--;
        }
      }
    }
    if (
      open < 0 ||
      !/(?:^|[^\w$.])cn\s*$/.test(masked.slice(Math.max(0, open - 8), open))
    ) {
      out.push(
        `${rel}:${line}: G2 ${m[0]} is used outside a direct cn( argument`,
      );
      continue;
    }
    const close = matchBrace(masked, open);
    if (close < 0) throw new ScanError(`${rel}:${line}: cn( never closes`);
    const bad = tokensOf(literalText(text, masked, open, close + 1)).filter(
      (t) => t !== "mb-0" && SPACING.test(bare(t)),
    );
    if (bad.length > 0) {
      out.push(
        `${rel}:${line}: G2 ${m[0]} call site overrides its bottom pair (${bad.join(" ")})`,
      );
    }
    sites++;
  }
  return sites;
}

/** G3 over one .tsx file: the line of each flagged literal scroller, plus the
 *  count of literal scrollers read. */
function scrollerFlags(rel, text, masked) {
  const flagged = [];
  let literals = 0;
  for (const tag of tagsIn(rel, text, masked, 0, masked.length)) {
    if (new RegExp(NAME_RE.source).test(masked.slice(tag.s, tag.e))) continue;
    const cls = classValue(text, masked, tag.s, tag.e);
    if (!cls.tokens.some((t) => SCROLL.test(bare(t)))) continue;
    literals++;
    if (padded(cls)) continue;
    const { close } = elementBounds(rel, text, masked, tag.s, tag.e, tag.name);
    const hit = tagsIn(rel, text, masked, tag.e, close).some((t) =>
      TOGGLES.has(t.name.split(".").pop()),
    );
    if (hit) flagged.push(lineOf(text, tag.s));
  }
  return { flagged, literals };
}

/** The whole `className={…}` expression on the opening tag at `s`, whitespace
 *  collapsed with none inside the call's parens and no trailing comma (the
 *  formatter's multi-line spelling), or undefined when the tag has none. */
function rootExpression(text, masked, s) {
  const e = tagEnd(masked, s) + 1;
  const hits = [...masked.slice(s, e).matchAll(/\sclassName\s*=\s*/g)].filter(
    (m) => topLevel(masked, s, s + m.index),
  );
  if (hits.length !== 1) return undefined;
  const open = s + hits[0].index + hits[0][0].length;
  if (masked[open] !== "{") return undefined;
  const close = matchBrace(masked, open);
  if (close < 0 || close >= e) return undefined;
  return text
    .slice(open + 1, close)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

/** G4's roster pins. */
function rosterProblems(files) {
  const out = [];
  const holders = [...files.keys()]
    .filter((rel) => rel.startsWith(VENDORED) && rel.endsWith(".tsx"))
    .filter((rel) => files.get(rel).includes("after:-inset"))
    .sort();
  if (JSON.stringify(holders) !== JSON.stringify(TOGGLE_UI)) {
    out.push(`G4 vendored toggles with after:-inset are ${holders.join(", ")}`);
  }
  for (const [rel, [root, pin]] of Object.entries(ROOT_PINS)) {
    const text = files.get(rel);
    if (text === undefined) {
      out.push(`${rel}: G4 not in the corpus`);
      continue;
    }
    const masked = mask(rel, text);
    const opens = [
      ...masked.matchAll(new RegExp(`<${escapeRe(root)}(?![\\w.$-])`, "g")),
    ];
    if (opens.length !== 1) {
      out.push(`${rel}: G4 ${opens.length} <${root}> tags, pin expects 1`);
      continue;
    }
    const s = opens[0].index;
    if (rootExpression(text, masked, s) !== `cn("${pin}", className)`) {
      out.push(
        `${rel}:${lineOf(text, s)}: G4 the vendored ${rel} root classes changed: re-measure its hit-area overhang (the 8 px padding floor G1/G3 rely on), then update this pin`,
      );
    }
  }
  for (const [rel, module] of Object.entries(WRAPPERS)) {
    const text = files.get(rel);
    if (text === undefined || !text.includes(`from "${module}"`)) {
      out.push(`${rel}: G4 no longer imports ${module}`);
    }
  }
  return out;
}

export function problems(files, allowlist = ALLOWLIST) {
  if (files.size === 0) return ["the walk read zero files"];
  const out = [...constantProblems(files), ...rosterProblems(files)];
  let sites = 0;
  let literals = 0;
  const flags = new Map();
  for (const [rel, text] of files) {
    const masked = mask(rel, text);
    sites += referenceProblems(rel, text, masked, out);
    if (!rel.endsWith(".tsx") || rel.startsWith(VENDORED)) continue;
    const got = scrollerFlags(rel, text, masked);
    literals += got.literals;
    if (got.flagged.length > 0) flags.set(rel, got.flagged);
  }
  if (sites === 0) out.push("G6 no DIALOG_SCROLL call sites found");
  if (literals === 0) out.push("G6 no literal scrollers found");
  for (const [rel, lines] of flags) {
    const entry = allowlist[rel];
    if (entry === undefined) {
      for (const line of lines) {
        out.push(
          `${rel}:${line}: G3 a toggle sits in a scroller with < 8px bottom padding`,
        );
      }
    } else if (entry.count !== lines.length) {
      out.push(
        `${rel}:${lines.join(",")}: G3 ${lines.length} flagged scroller(s), allowlist says ${entry.count}`,
      );
    }
  }
  for (const rel of Object.keys(allowlist)) {
    if (!flags.has(rel)) out.push(`${rel}: G5 stale allowlist entry`);
  }
  return out;
}

const CORPUS = loadCorpus(srcEntries(ROOT));

test("the real tree passes G1-G6", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("the allowlist holds exactly its three reviewed entries", () => {
  assert.equal(Object.keys(ALLOWLIST).length, 3);
  for (const entry of Object.values(ALLOWLIST)) {
    assert.equal(entry.count, 1);
    assert.ok(entry.rationale.length > 0);
  }
});

const STUB = "src/features/zz/Stub.tsx";
const STUB_TEXT = [
  'import { cn } from "@/lib/utils";',
  'import { DIALOG_SCROLL } from "@/components/dialog-scroll";',
  "export const Stub = () => (",
  '  <div className={cn(DIALOG_SCROLL, "flex-1")}>',
  '    <div className="overflow-y-auto pb-2">x</div>',
  "  </div>",
  ");",
  "",
].join("\n");
/** A minimal corpus for the synthetic checks: the files G1 and G4 read, a stub
 *  holding one call site and one scroller (G6), plus the named real files. */
function mini(...extra) {
  const files = new Map([[STUB, STUB_TEXT]]);
  for (const rel of [DEF, ...TOGGLE_UI, ...Object.keys(WRAPPERS), ...extra]) {
    const real = CORPUS.get(rel);
    assert.ok(real, rel);
    files.set(rel, real);
  }
  return files;
}
/** The allowlist rows for files present in `files`. */
const only = (files, allowlist = ALLOWLIST) =>
  Object.fromEntries(
    Object.entries(allowlist).filter(([rel]) => files.has(rel)),
  );

test("the minimal corpus passes on its own", () => {
  const files = mini();
  assert.deepEqual(problems(files, only(files)), []);
});

const defWith = (a, b = a) =>
  new Map([
    [
      DEF,
      `export const DIALOG_SCROLL = "${a}";\nexport const DIALOG_SCROLL_X_HIDDEN =\n  "${b}";\n`,
    ],
  ]);

test("G1: the bottom pair must be present, matched and at least 2", () => {
  const good = "-mx-1 -mb-2 overflow-y-auto px-1 pb-2";
  assert.deepEqual(constantProblems(defWith(good)), []);
  for (const bad of [
    "-mx-1 overflow-y-auto px-1 pb-2",
    "-mx-1 -mb-2 overflow-y-auto px-1",
    "-mx-1 -mb-3 overflow-y-auto px-1 pb-2",
    "-mx-1 -mb-1 overflow-y-auto px-1 pb-1",
    "-mx-1 -mb-2 overflow-y-auto px-1 pb-2 py-1",
  ]) {
    assert.match(
      constantProblems(defWith(bad)).join("\n"),
      /G1 DIALOG_SCROLL /,
    );
  }
  const computed = new Map([
    [
      DEF,
      'export const DIALOG_SCROLL = `${"a"}`;\nexport const DIALOG_SCROLL_X_HIDDEN = "b";\n',
    ],
  ]);
  assert.match(constantProblems(computed).join("\n"), /not a single string/);
  assert.match(
    constantProblems(new Map([[DEF, "export const X = 1;\n"]])).join("\n"),
    /DIALOG_SCROLL is not an exported const/,
  );
});

const REL = "src/features/zz/Fixture.tsx";
const g2 = (body) => {
  const text = `import { cn } from "@/lib/utils";\nimport { DIALOG_SCROLL } from "@/components/dialog-scroll";\nexport const A = () => ${body};\n`;
  const out = [];
  const sites = referenceProblems(REL, text, mask(REL, text), out);
  return { out, sites };
};

test("G2: call-site bottom overrides fail; mb-0 passes", () => {
  for (const cls of [
    "py-1",
    "sm:pb-0",
    "-my-1",
    "p-4",
    "!pb-0",
    "pbe-0",
    "-mbe-2",
    "pb-[length:1px]!",
    "sm:pb-(length:--x)",
  ]) {
    const { out } = g2(
      `<div className={cn(DIALOG_SCROLL, "flex-1 ${cls}")} />`,
    );
    assert.match(out.join("\n"), /G2 DIALOG_SCROLL call site overrides/, cls);
  }
  for (const cls of ["mb-0 flex-1", "-mt-1 pt-1 min-h-0"]) {
    assert.deepEqual(
      g2(`<div className={cn(DIALOG_SCROLL, "${cls}")} />`),
      { out: [], sites: 1 },
      cls,
    );
  }
  assert.deepEqual(g2("<div className={DIALOG_SCROLL} />"), {
    out: [],
    sites: 1,
  });
});

test("G2: a reference outside a direct cn( argument fails closed", () => {
  for (const body of [
    "<div className={`${DIALOG_SCROLL} py-1`} />",
    '<div className={DIALOG_SCROLL + " py-1"} />',
    '<div className={clsx(DIALOG_SCROLL, "py-1")} />',
    '<div className={cn(x ? DIALOG_SCROLL : "", "py-1")} />',
  ]) {
    assert.match(g2(body).out.join("\n"), /used outside a direct cn\(/, body);
  }
  const aliased = `import { DIALOG_SCROLL as S } from "@/components/dialog-scroll";\n`;
  const out = [];
  referenceProblems(REL, aliased, mask(REL, aliased), out);
  assert.match(out.join("\n"), /G2 aliased import of DIALOG_SCROLL/);
});

/** `cls` is a plain class string, or a whole `{…}` className expression. */
const g3 = (inner, cls = "max-h-56 overflow-y-auto") => {
  const attr = cls.startsWith("{") ? cls : `"${cls}"`;
  const text = `export const A = () => (\n  <div className=${attr}>\n${inner}\n  </div>\n);\n`;
  return scrollerFlags(REL, text, mask(REL, text)).flagged;
};

/** The A4 shapes: a toggle that still sits last, or not last at all. */
const ANYWHERE = [
  '<Checkbox />\n<p className="hidden sm:block">Help</p>',
  '<p>a</p>\n<div className="hidden sm:block"><Checkbox /></div>',
  "<Switch />\n<p hidden={!expanded}>x</p>",
  "<Checkbox />\n<SomeDialog />",
  '<Switch />\n<Activity mode="hidden">\n<p>x</p>\n</Activity>',
  '<Radio />\n<p className="[display:none]">x</p>',
  "<Checkbox />\n<p>b</p>\n<p>c</p>",
  "{rows.map((r) => <Radio key={r} value={r} />)}\n<p>after</p>",
  '<p>a</p>\n<field.CheckboxField label="x" />',
  "<>\n<Switch />\n</>\n<p>after</p>",
];

test("G3: a toggle anywhere flags an unpadded scroller", () => {
  for (const inner of ANYWHERE) assert.deepEqual(g3(inner), [2], inner);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto sm:pb-2"), [2]);
  for (const cls of [
    "overflow-y-auto pb-[7px]",
    "overflow-y-auto p-2 pb-px",
    "overflow-y-auto pb-2 sm:pb-0",
    "overflow-y-auto py-2 md:py-1",
    "overflow-y-auto pb-2 !pb-1",
    "overflow-y-auto pb-[2em]",
    "overflow-y-auto pb-(--gap)",
    "overflow-y-auto pb-2 pb-[length:1px]!",
    "overflow-y-auto pb-2 sm:!pb-[1px]",
    // Plain strings: no removal, the more specific property wins, and two
    // values at one specificity are stylesheet-ordered.
    "overflow-y-auto pb-1 p-2",
    "overflow-y-auto pb-px pb-2",
    "overflow-y-auto pb-2 pbe-1",
    '{cn("overflow-y-auto p-2", "pb-1")}',
    '{cn("overflow-y-auto pb-2", "pbe-1")}',
    // Only a single whole-expression cn( merges.
    '{cn("overflow-y-auto pb-1", "p-2") + " x"}',
  ]) {
    assert.deepEqual(g3("<p>a</p>\n<Switch />", cls), [2], cls);
  }
  // Padding spelled in another attribute is not the scroller's class.
  const titled = g3("<p>a</p>\n<Switch />", 'overflow-y-auto" title="pb-2');
  assert.deepEqual(titled, [2]);
  // A nested scroller no longer shields the outer one.
  assert.deepEqual(
    g3('<div className="max-h-40 overflow-y-auto pb-2">\n<Checkbox />\n</div>'),
    [2],
  );
  assert.deepEqual(
    g3('<div className="max-h-40 overflow-y-auto">\n<Checkbox />\n</div>'),
    [2, 3],
  );
});

test("G3: a padded scroller or one without a toggle passes", () => {
  for (const inner of ANYWHERE) {
    assert.deepEqual(g3(inner, "max-h-56 overflow-y-auto pb-2"), [], inner);
  }
  assert.deepEqual(g3("<p>a</p>\n<SomeDialog />\n<p>b</p>"), []);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto p-3"), []);
  for (const cls of [
    "overflow-y-auto py-2",
    "overflow-y-auto pb-[10px]",
    "overflow-y-auto pb-[0.5rem]",
    "overflow-y-auto pbe-2",
    "overflow-y-auto py-1 pb-2",
    "overflow-y-auto p-0 py-1 pb-2 pbe-2",
    '{cn("overflow-y-auto pb-1", "p-2")}',
    '{cn("overflow-y-auto pb-1", "py-2")}',
    '{cn("overflow-y-auto pb-px pb-2")}',
    '{cn("overflow-y-auto pb-1 sm:pb-3", cond && "pb-2")}',
  ]) {
    assert.deepEqual(g3("<p>a</p>\n<Switch />", cls), [], cls);
  }
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-hidden"), []);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-x-auto"), []);
});

/** A scroller whose other attribute holds an element with its own classes. */
const nestedAttr = (own) =>
  [
    "export const A = () => (",
    `  <LabeledGroup className="${own}" actions={<button className="relative pb-2" />}>`,
    "    <Checkbox />",
    "  </LabeledGroup>",
    ");",
    "",
  ].join("\n");

test("G3: classes inside another attribute's value are not the tag's", () => {
  const read = (own) => {
    const text = nestedAttr(own);
    return scrollerFlags(REL, text, mask(REL, text)).flagged;
  };
  assert.deepEqual(read("overflow-y-auto"), [2]);
  assert.deepEqual(read("overflow-y-auto pb-2"), []);
});

test("G4: a root className inside another attribute's value is not the root's", () => {
  const [rel, [root, pin]] = Object.entries(ROOT_PINS)[0];
  const files = mini();
  const real = files.get(rel);
  const decoy = ` render={<i className={cn("${pin}", className)} />}`;
  const next = real
    .replace(`"${pin}",`, () => `"${pin}", "after:h-11",`)
    .replace(`<${root}`, () => `<${root}${decoy}`);
  assert.equal(next.split(decoy).length, 2);
  files.set(rel, next);
  assert.deepEqual(
    problems(files, {}).map((p) => p.replace(/:\d+:/, ":N:")),
    [
      `${rel}:N: G4 the vendored ${rel} root classes changed: re-measure its hit-area overhang (the 8 px padding floor G1/G3 rely on), then update this pin`,
    ],
  );
});

test("G4: an aliased toggle import fails closed", () => {
  const text = `import { Checkbox as Box } from "@/components/ui/checkbox";\n`;
  const out = [];
  referenceProblems(REL, text, mask(REL, text), out);
  assert.match(out.join("\n"), /G4 aliased import of Checkbox/);
  const commented = text.replace("Checkbox as", "Checkbox /* x */ as");
  assert.notEqual(commented, text);
  const commentedOut = [];
  referenceProblems(REL, commented, mask(REL, commented), commentedOut);
  assert.deepEqual(commentedOut, out);
  const ns = `import * as T from "@/components/ui/switch";\n`;
  const nsOut = [];
  referenceProblems(REL, ns, mask(REL, ns), nsOut);
  assert.match(nsOut.join("\n"), /G4 namespace import/);
});

test("G4: the vendored roster, root literals and wrappers' imports are pinned", () => {
  const rel = "src/components/ui/tabs.tsx";
  const more = mini().set(rel, `const c = "after:-inset-y-1";\n`);
  assert.deepEqual(problems(more, {}), [
    "G4 vendored toggles with after:-inset are src/components/ui/checkbox.tsx, src/components/ui/radio-group.tsx, src/components/ui/switch.tsx, src/components/ui/tabs.tsx",
  ]);
  for (const [rel, [, pin]] of Object.entries(ROOT_PINS)) {
    for (const extra of [" after:h-11", " after:-bottom-4!", " p-1"]) {
      const files = mini();
      const real = files.get(rel);
      assert.equal(real.split(pin).length, 2, `${rel}: its root literal once`);
      files.set(
        rel,
        real.replace(pin, () => pin + extra),
      );
      assert.deepEqual(
        problems(files, {}).map((p) => p.replace(/:\d+:/, ":N:")),
        [
          `${rel}:N: G4 the vendored ${rel} root classes changed: re-measure its hit-area overhang (the 8 px padding floor G1/G3 rely on), then update this pin`,
        ],
        `${rel}${extra}`,
      );
    }
    // The whole expression is pinned: an extra cn( argument or another call.
    for (const [label, edit] of [
      [
        "extra arg",
        (t) => t.replace(`"${pin}",`, () => `"${pin}", "after:h-11",`),
      ],
      [
        "clsx",
        (t) => {
          const at = t.lastIndexOf("cn(", t.indexOf(`"${pin}"`));
          return `${t.slice(0, at)}clsx(${t.slice(at + 3)}`;
        },
      ],
    ]) {
      const files = mini();
      const next = edit(files.get(rel));
      assert.notEqual(next, files.get(rel), `${rel} ${label}`);
      files.set(rel, next);
      assert.deepEqual(
        problems(files, {}).map((p) => p.replace(/:\d+:/, ":N:")),
        [
          `${rel}:N: G4 the vendored ${rel} root classes changed: re-measure its hit-area overhang (the 8 px padding floor G1/G3 rely on), then update this pin`,
        ],
        `${rel} ${label}`,
      );
    }
  }
  const held = "src/components/held-switch.tsx";
  const moved = mini().set(held, "export const HeldSwitch = 1;\n");
  assert.deepEqual(problems(moved, {}), [
    "src/components/held-switch.tsx: G4 no longer imports @/components/ui/switch",
  ]);
});

test("G5: stale or drifted allowlist counts fail", () => {
  const rel = "src/features/settings/mcp/ImportMcpDialog.tsx";
  const drifted = { ...ALLOWLIST, [rel]: { ...ALLOWLIST[rel], count: 2 } };
  const files = mini(rel);
  const got = problems(files, only(files, drifted));
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    new RegExp(
      `^${escapeRe(rel)}:\\d+: G3 1 flagged scroller\\(s\\), allowlist says 2$`,
    ),
  );
  const stale = { ...only(files), "src/features/zz/Gone.tsx": { count: 1 } };
  assert.deepEqual(problems(files, stale), [
    "src/features/zz/Gone.tsx: G5 stale allowlist entry",
  ]);
});

test("G6: an empty corpus, or one with no scrollers or call sites, fails", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = problems(new Map([[REL, "export const a = 1;\n"]]), {});
  assert.ok(none.includes("G6 no DIALOG_SCROLL call sites found"));
  assert.ok(none.includes("G6 no literal scrollers found"));
  const broken = new Map([[REL, "export const A = () => <div>{</div>;\n"]]);
  assert.throws(() => problems(broken), ScanError);
});

/** The minimal corpus plus one real file, its text replaced once (the literal
 *  must occur exactly once), checked against that corpus's allowlist rows. */
function mutated(rel, from, to) {
  const files = mini(rel);
  const real = files.get(rel);
  assert.equal(real.split(from).length, 2, `${rel}: ${from} once`);
  files.set(
    rel,
    real.replace(from, () => to),
  );
  return problems(files, only(files));
}

test("NC1: DIALOG_SCROLL without pb-2 fails G1", () => {
  const got = mutated(
    DEF,
    '"-mx-1 -mb-2 overflow-y-auto px-1 pb-2"',
    '"-mx-1 -mb-2 overflow-y-auto px-1"',
  );
  assert.equal(got.length, 1);
  assert.match(got[0], /dialog-scroll\.ts:\d+: G1 DIALOG_SCROLL must carry/);
});

test("NC2: MergePrDialog's old -my-1/py-1 override fails G2", () => {
  const got = mutated(
    "src/features/pulls/MergePrDialog.tsx",
    '"-mt-1 min-h-0 min-w-0 flex-1 space-y-4 pt-1"',
    '"-my-1 min-h-0 min-w-0 flex-1 space-y-4 py-1"',
  );
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    /MergePrDialog\.tsx:\d+: G2 DIALOG_SCROLL call site overrides its bottom pair \(-my-1 py-1\)/,
  );
});

for (const [nc, rel, from] of [
  [
    "NC3",
    "src/features/projects/ProjectsBoardPanel.tsx",
    'className="max-h-56 gap-0 overflow-y-auto pb-2"',
  ],
  [
    "NC4",
    "src/features/issues/JiraIssueView.tsx",
    'className="mt-1 max-h-56 overflow-y-auto pb-2"',
  ],
  [
    "NC5",
    "src/features/repository/RepositoryFilesDialog.tsx",
    'className="h-full overflow-y-auto pb-2"',
  ],
]) {
  test(`${nc}: ${rel} without its pb-2 fails G3`, () => {
    const got = mutated(rel, from, from.replace(" pb-2", ""));
    assert.equal(got.length, 1);
    assert.match(
      got[0],
      new RegExp(`^${escapeRe(rel)}:\\d+: G3 a toggle sits`),
    );
  });
}

for (const [nc, rel] of [
  ["NC6", "src/features/settings/mcp/McpServerDialog.tsx"],
  ["NC7", "src/features/scripts/TaskDialog.tsx"],
]) {
  test(`${nc}: the allowlist without ${rel} fails G3`, () => {
    const { [rel]: _dropped, ...rest } = ALLOWLIST;
    const files = mini(rel);
    const got = problems(files, only(files, rest));
    assert.equal(got.length, 1);
    assert.match(
      got[0],
      new RegExp(
        `^${escapeRe(rel)}:\\d+: G3 a toggle sits in a scroller with < 8px bottom padding$`,
      ),
    );
  });
}
