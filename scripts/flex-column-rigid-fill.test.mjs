// An item that takes its parent's whole height (`h-full`) beside in-flow
// siblings in a flex column asks for the column's full height while starting
// below them; without `min-h-0` its automatic minimum stops it shrinking, so
// tall content pushes it past the column and the app root's `overflow-clip`
// cuts it off with no scrollbar. The model, read on masked source
// (`maskNonCode(text, true)`), each rule with a fixture below:
// - Corpus: every .tsx under src/ outside src/test/ (jsdom lays nothing out,
//   and its stand-ins reuse component names); src/components/ui/ is read to
//   resolve classes and never reported.
// - JSX tree per file: opening tags, fragments and closers nest; a tag inside
//   another tag's attribute value is its own tree, never a layout child; a
//   `<Name` whose `>` is followed by `(`, or that reads `<Name,` or
//   `<Name extends`, is a generic parameter list; a `<` after an identifier,
//   `)` or `]` is a comparison or a type argument unless the identifier is an
//   expression keyword (the masker's own rule). A tag with no closer throws.
// - Class tokens: the string literals of a tag's top-level `className`; a
//   variant-prefixed token is not read; a token is CONDITIONAL when its
//   literal sits in an operand holding `?:`, `&&`, `||` or `??` at any
//   bracket level, or inside an object literal (a `cn({…})` map); a plain
//   argument beside a conditional one is unconditional.
// - Resolution (`twResolve`): within the groups the guard reads (display,
//   sr, position, overflow, overflow-y, flex-direction, min-h, h, size; the
//   value sets of tailwind-merge 3.7.0, checked against the installed package
//   when node_modules exists), a value one `cn(…)`/`twMerge(…)` call builds
//   (`cn` imported from src/lib/utils) keeps a group's LAST member and drops
//   the earlier ones (a conditional later member makes them conditional);
//   any other class string (a literal, a template, a non-merging call), and
//   a pair both kept by the merge that set one property (size and h,
//   overflow and overflow-y), leaves the stylesheet's order to decide, so
//   each of a differing pair is conditional; an important `!` member beats a
//   plain one either way. Property: a relief token counts only when no other
//   token can override it on the box.
// - Component roots: a column-0 `export function`, `export default function`,
//   `function`, `export const Name =` or `const Name =` (async, generic and
//   typed forms included) with a capitalized name. Its roots are the
//   parentless tags a `return` reaches with no `;`, `=>` or `function`
//   between while only the component's own function body is open (control
//   blocks don't count), or the expression body of the arrow. A transparent
//   root contributes each child as a root. A mount has one class set per root
//   (recursive, cycle-guarded); a same-file definition wins, then the one the
//   file's import names (`@/` or relative; a package import resolves to
//   none), else every exported definition of that name.
// - A root's className is its LAST writer in attribute order: an explicit
//   `className` (its own tokens, plus the mount's at the place its `{…}`
//   names `className` or `props.className`, conditional in a conditional
//   operand, then resolved as above), or a spread, which may carry the
//   mount's className and so replaces every earlier writer with the mount's
//   tokens whenever the mount passes one, unless it spreads the rest of a
//   parameter pattern that took `className` out. A component with no root
//   found is read by its mount's tokens alone.
// - RIGID: a class set holds `h-full` or `size-full` (conditional counts) and
//   no unconditional `min-h-0`, `overflow(-y)-auto|scroll|hidden`, `absolute`,
//   `fixed`, `sr-only` or `hidden` (read after resolution, so a merged later
//   display member drops `hidden` and an unmerged one makes it conditional).
// - Transparent nodes, climbed through for parents and expanded for roots and
//   siblings: fragments, `Fragment`, `React.Fragment`, `Suspense`, `Activity`,
//   names ending `Context`, `Provider` or `ErrorBoundary`, and a lowercase tag
//   with an unconditional `contents` in its resolved class set (`!` markers
//   stripped; read with no mount, as RIGID reads it: a merged later display
//   member drops it, an unmerged one makes it conditional).
// - Siblings: the other child slots of the first non-transparent ancestor (one
//   direct child tag, or one top-level `{…}` child expression whose alternates
//   are one slot). A slot counts when it can paint in flow: a tag with a class
//   set free of an unconditional `absolute`, `fixed`, `sr-only` or `hidden`;
//   non-blank JSX text; an expression with one VALUE ARM that counts. Arms:
//   both results of `?:`, every operand of `||` and `??`, the last operand
//   of `&&`, recursively, parens trimmed. An arm holding JSX counts by its
//   tags; a tag-free arm counts unless blank or a literal that paints nothing
//   (`null`, `undefined`, `true`, `false`, a white-space-only string), a bare
//   identifier bound once in the file to JSX being read as that JSX. A
//   self-closing `<span … />` with no
//   spread, no `style`, a `className` absent or one string literal, and every
//   token on the closed non-box list (NON_BOX) doesn't count; a parent's
//   `space-y-*` makes every child count.
// - FAIL: rigid, at least one counted sibling, and the ancestor resolves to a
//   flex column (`flex`/`inline-flex` with `flex-col(-reverse)`, conditional
//   counts), or there is no such ancestor (a multi-child fragment handed to
//   code the scan can't follow: fail closed).
// ALLOWLIST rows are per-file counts with a rationale; a drifted count or a
// row with no finding fails, and so do zero files, zero component roots, zero
// rigid nodes, an unreadable file, a tag that never closes and a `className`
// value running past its tag.
// OUT OF SIGHT, closed list (each shape is deliberately unmodelled; a new
// one joins this list or the model, never neither):
//  1. Classes from constants, props, a template's `${…}` values or a spread's
//     object (only string literals in the expression are read).
//  2. Variant-prefixed classes (`md:min-h-0`), and how a variant member
//     overrides a base one at that breakpoint or state.
//  3. tailwind-merge groups the guard doesn't read, a custom merge config,
//     and conflicts the merge leaves to the stylesheet across groups it
//     doesn't read (`max-h-*` against `h-full`, `inset-*`, `basis-*`).
//  4. A component that lays `children` out in an inner column (only its root
//     is read).
//  5. A root returned any other way (`memo` / `forwardRef` call forms), or
//     reached through `lazy()` (the DiffSurfaceLazy wrappers) or a name the
//     scan can't resolve: its mount classes are taken as its box's.
//  6. A parentless tag handed to a helper the component returns
//     (`return shell(<X />)`), read as a root whatever the helper wraps it in.
//  7. A root that receives `className` under another prop name, forwards it
//     through a local (`const base = cn(…, className)`) or reads it off an
//     object not named `props`: read as "not read", which drops a mount's
//     `h-full` (one live instance, src/features/actions/status.tsx, an icon).
//  8. A rest taken out in the body (`const { className, ...rest } = props`),
//     read as carrying the mount's className, which drops the root's tokens.
//  9. A rigid tag bound to a local and placed by name (read where written).
// 10. Whether an unfollowed container really is a column; a block (non-flex)
//     parent of definite height; a `gap-*` the column adds around an empty
//     span; a conditional or variant `contents`, and a root's `contents` that
//     its mount's className overrides.
// 11. A `{items.map(…)}` (any arm holding JSX that isn't one element) is read
//     by its tags alone, so a string a callback or call returns beside JSX
//     (`render("x", <A />)`) is not counted, and repeated rigid items never
//     count as siblings of each other.
// 12. The left operand of `&&`, which renders when it is `0` or `NaN`.
// 13. Whether the content can actually outgrow the space.
import assert from "node:assert/strict";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSE,
  EXPR_KEYWORDS,
  EXPR_OPENERS,
  hasSpread,
  lineOf,
  loadCorpus,
  maskNonCode,
  matchBrace,
  OPEN,
  ScanError,
  srcEntries,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS = "src/test/";
const VENDORED = "src/components/ui/";

/** Reviewed findings, `{ count, rationale }` per file. */
const ALLOWLIST = {};

const FILL = /^(?:h-full|size-full)$/;
const RELIEF =
  /^(?:min-h-0|overflow-(?:y-)?(?:auto|scroll|hidden)|absolute|fixed)$/;
const OUT_OF_FLOW = /^(?:absolute|fixed|sr-only|hidden)$/;
/** A child expression that paints nothing in a flex column: React renders
 *  these literals as nothing, and a flex container drops white-space-only
 *  text. */
const NON_RENDERING = /^(?:null|undefined|false|true|(["'`])\s*\1)$/;
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);
const BLOCK_WORDS = new Set(["else", "try", "finally", "do"]);

/** Tokens that give an empty span no box: outlines, rings, `sr-only`, text
 *  colours, cursor, selection and pointer-events, and focus outline/ring. */
const NON_BOX = (tok) =>
  /^(?:focus-visible|focus):(?:outline|ring)(?:-|$)/.test(tok) ||
  /^(?:outline(?:-.+)?|ring(?:-.+)?|sr-only|cursor-.+|select-.+|pointer-events-.+)$/.test(
    tok,
  ) ||
  (/^text-./.test(tok) &&
    !/^text-(?:xs|sm|base|lg|\d*xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\[)/.test(
      tok,
    ));

const MESSAGE = (rel, line, name, n) =>
  `${rel}:${line}: ${name} takes its parent's whole height (h-full) beside ${n} in-flow sibling(s) in a flex column; give it, or its component's root, min-h-0 (flex-1 min-h-0 to take the rest), or mount it alone in a min-h-0 flex-1 box`;

/** A token's utility, or "" when a variant prefix guards it (a `:` outside
 *  `[…]`/`(…)`); an important `!` is stripped. */
function readToken(tok) {
  let depth = 0;
  for (const c of tok) {
    if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    else if (c === ":" && depth === 0) return "";
  }
  return tok.replace(/^!|!$/g, "");
}

/** tailwind-merge 3.7.0's default class groups (`getDefaultConfig`) holding a
 *  utility this guard reads, each with every value the group accepts; the
 *  agreement test below re-checks them against the installed package. */
const isNum = (v) => v !== "" && !Number.isNaN(Number(v));
const SIZING = (v) =>
  /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(v) ||
  /^(?:auto|full|dvw|dvh|lvw|lvh|svw|svh|min|max|fit|px)$/.test(v) ||
  isNum(v) ||
  /^\[.+\]$/.test(v) ||
  /^\(.+\)$/.test(v);
const OVERFLOW = /^(?:auto|hidden|clip|visible|scroll)$/;
const TW_GROUPS = [
  [
    "display",
    (u) =>
      /^(?:block|inline-block|inline|flex|inline-flex|table|inline-table|table-caption|table-cell|table-column|table-column-group|table-footer-group|table-header-group|table-row-group|table-row|flow-root|grid|inline-grid|contents|list-item|hidden)$/.test(
        u,
      ),
  ],
  ["sr", (u) => u === "sr-only" || u === "not-sr-only"],
  ["position", (u) => /^(?:static|fixed|absolute|relative|sticky)$/.test(u)],
  ["overflow-y", (u) => /^overflow-y-/.test(u) && OVERFLOW.test(u.slice(11))],
  ["overflow", (u) => /^overflow-/.test(u) && OVERFLOW.test(u.slice(9))],
  [
    "flex-direction",
    (u) => /^flex-(?:row|row-reverse|col|col-reverse)$/.test(u),
  ],
  [
    "min-h",
    (u) =>
      u.startsWith("min-h-") &&
      (/^(?:screen|lh|none)$/.test(u.slice(6)) || SIZING(u.slice(6))),
  ],
  [
    "h",
    (u) =>
      u.startsWith("h-") &&
      (/^(?:screen|lh)$/.test(u.slice(2)) || SIZING(u.slice(2))),
  ],
  ["size", (u) => u.startsWith("size-") && SIZING(u.slice(5))],
];
/** The groups a later member of a group also removes (`conflictingClassGroups`,
 *  read groups only). */
const TW_CONFLICTS = { overflow: ["overflow-y"], size: ["h"] };

const twGroup = (tok) => {
  const u = readToken(tok);
  return u ? TW_GROUPS.find(([, test]) => test(u))?.[0] : undefined;
};

/** The tokens of one box after its class string resolves, `merged` when
 *  tailwind-merge built it (`cn`). Merged, a later member of a token's group
 *  (or of a group that removes it) drops it, or makes it conditional when
 *  that member is conditional. Unmerged, or where both survive the merge but
 *  set one property, the stylesheet's order decides, so each of a differing
 *  pair becomes conditional. An important (`!`) member beats a plain one in
 *  any order. */
function twResolve(tokens, merged) {
  const info = tokens.map((t) => ({
    g: twGroup(t.tok),
    imp: /^!|!$/.test(t.tok),
    u: readToken(t.tok),
  }));
  const removes = (b, a) => b.g === a.g || TW_CONFLICTS[b.g]?.includes(a.g);
  const out = [];
  tokens.forEach((t, i) => {
    const a = info[i];
    let cond = t.cond;
    let dropped = false;
    info.forEach((b, j) => {
      if (j === i || !a.g || !b.g || !(removes(b, a) || removes(a, b))) return;
      if (b.imp !== a.imp ? b.imp : merged && j > i && removes(b, a)) {
        if (tokens[j].cond) cond = true;
        else dropped = true;
      } else if (b.imp !== a.imp) {
        return;
      } else if (!(merged && j < i && removes(a, b)) && b.u !== a.u) {
        cond = true;
      }
    });
    if (!dropped) out.push(cond === t.cond ? t : { ...t, cond });
  });
  return out;
}

const anyRead = (set, re, uncond = false) =>
  set.some((t) => (!uncond || !t.cond) && re.test(readToken(t.tok)));
const inFlow = (set) => !anyRead(set, OUT_OF_FLOW, true);
// A box out of flow takes no space in the column, so it can't overflow it.
const isRigid = (set) =>
  anyRead(set, FILL) && !anyRead(set, RELIEF, true) && inFlow(set);
const isColumn = (set) =>
  anyRead(set, /^(?:inline-)?flex$/) && anyRead(set, /^flex-col(?:-reverse)?$/);

const skipWs = (s, i) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** The masker's expression-start test, read on the masked text: whether a `<`
 *  at `i` opens JSX rather than a comparison or a type argument. */
function exprStartAt(masked, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (k < 0) return true;
  if (/[\w$]/.test(masked[k])) {
    let s = k;
    while (s > 0 && /[\w$]/.test(masked[s - 1])) s--;
    if (masked[s - 1] === "." && masked[s - 2] !== ".") return false;
    const word = masked.slice(s, k + 1);
    return word !== "of" && EXPR_KEYWORDS.has(word);
  }
  if (masked[k] === "!") {
    let s = k;
    while (s > 0 && masked[s - 1] === "!") s--;
    if (s > 0 && /[\w$)\]`]/.test(masked[s - 1])) return false;
  }
  return EXPR_OPENERS.has(masked[k]);
}

/** Past the `<…>` type parameter list opening at `i`. */
function skipAngles(masked, i) {
  let depth = 0;
  for (; i < masked.length; i++) {
    if (masked[i] === "<") depth++;
    else if (masked[i] === ">" && masked[i - 1] !== "=" && --depth === 0) {
      return i + 1;
    }
  }
  throw new ScanError("unreadable type parameters");
}

/** Whether offset `i` of the opening tag at `s` sits outside every
 *  attribute's `{…}` value. */
function topLevel(masked, s, i) {
  let depth = 0;
  for (let k = s; k < i; k++) {
    if (masked[k] === "{") depth++;
    else if (masked[k] === "}") depth--;
  }
  return depth === 0;
}

/** One file's JSX trees: `trees` in code (attribute-value trees included,
 *  flagged `inAttr`), every node in `nodes`. */
function parseJsx(text, masked) {
  const nodes = [];
  const trees = [];
  const fail = (what, at) => {
    throw new ScanError(`${what} at line ${lineOf(text, at)}`);
  };

  /** Trees in the code range [from, to). */
  function codeTrees(from, to, sink, inAttr) {
    for (let i = from; i < to; i++) {
      if (masked[i] !== "<" || !exprStartAt(masked, i)) continue;
      if (!/[A-Za-z_$>]/.test(masked[skipWs(masked, i + 1)] ?? "")) continue;
      const node = element(i, inAttr);
      if (!node) continue;
      sink(node);
      i = node.end - 1;
    }
  }

  /** The element at `start`, or null for a generic parameter list. */
  function element(start, inAttr) {
    let i = skipWs(masked, start + 1);
    const name = /^[\w$.:-]*/.exec(masked.slice(i))[0];
    i += name.length;
    if (name && /^\s*(?:,|extends\b)/.test(masked.slice(i))) return null;
    if (name && masked[i] === "<") i = skipAngles(masked, i);
    let e = i;
    for (let depth = 0; ; e++) {
      if (e >= masked.length) fail("a tag that never closes", start);
      const c = masked[e];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const selfClosing = masked[e - 1] === "/";
    if (!selfClosing && name && /^\s*\(/.test(masked.slice(e + 1))) {
      return null;
    }
    const node = {
      name,
      start,
      open: [start, e + 1],
      selfClosing,
      slots: [],
      parent: null,
      inAttr,
    };
    nodes.push(node);
    // Attribute-value trees stand alone.
    for (let k = i, depth = 0; k < e; k++) {
      if (masked[k] === "{") {
        if (depth === 0) {
          const close = matchBrace(masked, k);
          if (close < 0 || close > e) fail("an attribute never ends", k);
          codeTrees(k + 1, close, (t) => trees.push(t), true);
          k = close;
          continue;
        }
        depth++;
      } else if (masked[k] === "}") depth--;
    }
    if (selfClosing) {
      node.end = e + 1;
      return node;
    }
    for (let j = e + 1; ; ) {
      if (j >= masked.length) fail("a tag that never closes", start);
      const c = masked[j];
      if (c === "{") {
        const close = matchBrace(masked, j);
        if (close < 0) fail("a child expression never ends", j);
        const slot = { kind: "expr", start: j, end: close + 1, trees: [] };
        codeTrees(
          j + 1,
          close,
          (t) => {
            t.parent = node;
            slot.trees.push(t);
          },
          inAttr,
        );
        node.slots.push(slot);
        j = close + 1;
      } else if (c === "<") {
        const k = skipWs(masked, j + 1);
        if (masked[k] === "/") {
          const end = masked.indexOf(">", k);
          if (end < 0 || masked.slice(k + 1, end).trim() !== name) {
            fail("a tag that never closes", start);
          }
          node.end = end + 1;
          return node;
        }
        const child = element(j, inAttr);
        if (!child) fail("unreadable JSX child", j);
        child.parent = node;
        node.slots.push({ kind: "tag", node: child });
        j = child.end;
      } else if (/\S/.test(text[j])) {
        // JSX text is blanked in the mask, so a run is read from the raw text.
        let k = j;
        while (k < masked.length && masked[k] !== "{" && masked[k] !== "<") k++;
        node.slots.push({ kind: "text", start: j, end: k, trees: [] });
        j = k;
      } else j++;
    }
  }

  codeTrees(0, masked.length, (t) => trees.push(t), false);
  return { nodes, trees };
}

/** A className expression that merges the caller's: `className` or
 *  `props.className`, never another object's member. */
const FORWARDS = /(?:(?<![\w$.])|(?<=(?<![\w$.])props\.))className(?![\w$])/;

/** Each string literal and template text segment in masked's [from, to), with
 *  its offset: `literalStrings` (ts-mask) with positions kept. */
function literalSpans(text, masked, from, to) {
  const out = [];
  const braces = [];
  const template = (start) => {
    let k = start;
    while (
      k < to &&
      masked[k] !== "`" &&
      !(masked[k] === "$" && masked[k + 1] === "{")
    )
      k++;
    if (k >= to) throw new ScanError("a template literal runs past its range");
    out.push({ s: text.slice(start, k), at: start });
    if (masked[k] === "`") return k + 1;
    braces.push(0);
    return k + 2;
  };
  let i = from;
  while (i < to) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      const j = masked.indexOf(c, i + 1);
      if (j < 0 || j >= to) throw new ScanError("a string runs past its range");
      out.push({ s: text.slice(i + 1, j), at: i });
      i = j + 1;
    } else if (c === "`") {
      i = template(i + 1);
    } else if (braces.length > 0 && c === "{") {
      braces[braces.length - 1]++;
      i++;
    } else if (braces.length > 0 && c === "}") {
      if (braces[braces.length - 1] === 0) {
        braces.pop();
        i = template(i + 1);
      } else {
        braces[braces.length - 1]--;
        i++;
      }
    } else i++;
  }
  return out;
}

/** Whether a `?`, `&&`, `||` or `??` sits at depth 0 of the comma-separated
 *  operand of the group content [from, to) that holds offset `at`. */
function operandConditional(masked, from, to, at) {
  let depth = 0;
  let hit = false;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth !== 0) continue;
    else if (c === ",") {
      if (i > at) break;
      hit = false;
    } else if (
      (c === "?" && masked[i + 1] !== ".") ||
      (c === "&" && masked[i + 1] === "&") ||
      (c === "|" && masked[i + 1] === "|")
    ) {
      hit = true;
    }
  }
  return hit;
}

/** Whether the literal at `at` in the className expression [from, to) is
 *  conditional: inside an object literal (a `cn({…})` map), or in an operand
 *  holding `?:`, `&&`, `||` or `??` at any enclosing bracket level. A plain
 *  argument beside a conditional one stays unconditional. */
function conditionalAt(masked, from, to, at) {
  const opens = [];
  for (let i = from; i < at; i++) {
    if (OPEN.has(masked[i])) opens.push(i);
    else if (CLOSE.has(masked[i])) opens.pop();
  }
  if (opens.some((o) => masked[o] === "{" && masked[o - 1] !== "$")) {
    return true;
  }
  const groups = [
    [from, to],
    ...opens.map((o) => [o + 1, matchBrace(masked, o)]),
  ];
  return groups.some(([gs, ge]) => operandConditional(masked, gs, ge, at));
}

/** The opening tag [from, end)'s top-level `{...x}` attributes, as className
 *  writers: offset, and the spread name when it is a bare identifier. */
function spreadsAt(masked, from, end) {
  const out = [];
  let depth = 0;
  for (let i = from; i < end; i++) {
    if (masked[i] === "}") depth--;
    else if (masked[i] === "{") {
      if (depth === 0 && /^\{\s*\.\.\./.test(masked.slice(i, end))) {
        const name = /^\{\s*\.\.\.\s*([\w$]+)\s*\}/.exec(masked.slice(i, end));
        out.push({ at: i, spread: true, name: name ? name[1] : null });
      }
      depth++;
    }
  }
  return out;
}

/** The tag's `className` reading: tokens (with their conditional flag),
 *  whether it is absent or one plain string literal, its className writers in
 *  attribute order, and its spread / `style`. */
function classInfo(f, node) {
  if (node.cls) return node.cls;
  const { text, masked } = f;
  const [s, e] = node.open;
  const tokens = [];
  const writers = [];
  let values = 0;
  let literal = true;
  const re = /\sclassName\s*=\s*/g;
  re.lastIndex = s;
  for (let m = re.exec(masked); m && m.index < e; m = re.exec(masked)) {
    if (!topLevel(masked, s, m.index)) continue;
    const v = m.index + m[0].length;
    let end = -1;
    let spans = [];
    let forwards = null;
    let merge = false;
    if (masked[v] === '"' || masked[v] === "'") {
      end = masked.indexOf(masked[v], v + 1) + 1;
      if (end > v && end <= e) {
        spans = [{ s: text.slice(v + 1, end - 1), cond: false, at: v }];
      }
    } else if (masked[v] === "{") {
      end = matchBrace(masked, v) + 1;
      const expr = masked.slice(v, end);
      literal = false;
      if (end > v && end <= e) {
        const fw = FORWARDS.exec(expr);
        if (fw) {
          const at = v + fw.index;
          forwards = { at, cond: conditionalAt(masked, v + 1, end - 1, at) };
        }
        merge = mergesClasses(f, masked, v, end);
        spans = literalSpans(text, masked, v + 1, end - 1).map((x) => ({
          s: x.s,
          cond: conditionalAt(masked, v + 1, end - 1, x.at),
          at: x.at,
        }));
      }
    }
    if (end <= v || end > e) {
      throw new ScanError(
        `a className value runs past its tag at line ${lineOf(text, s)}`,
      );
    }
    values++;
    const own = [];
    for (const { s: lit, cond, at } of spans) {
      for (const tok of lit.split(/\s+/)) if (tok) own.push({ tok, cond, at });
    }
    tokens.push(...own);
    writers.push({ at: m.index, tokens: own, forwards, merge });
  }
  const spread = hasSpread(masked, s, e);
  writers.push(...spreadsAt(masked, s, e));
  writers.sort((a, b) => a.at - b.at);
  const style = [...masked.slice(s, e).matchAll(/\sstyle\s*=/g)].some((m) =>
    topLevel(masked, s, s + m.index),
  );
  node.cls = {
    tokens,
    literal: values === 0 || (values === 1 && literal),
    writers,
    spread,
    style,
  };
  return node.cls;
}

/** Whether the `{…}` value at [v, end) is one call to tailwind-merge: `cn`
 *  imported from src/lib/utils, or `twMerge` from the package. */
function mergesClasses(f, masked, v, end) {
  const call = /^\{\s*([\w$]+)\s*\(/.exec(masked.slice(v, end));
  if (!call) return false;
  const close = matchBrace(masked, v + call[0].length - 1);
  if (close < 0 || masked.slice(close + 1, end - 1).trim() !== "") return false;
  const imp = f.imports.get(call[1]);
  if (!imp) return false;
  if (imp.from === "tailwind-merge") return imp.name === "twMerge";
  const target = imp.from.startsWith("@/")
    ? `src/${imp.from.slice(2)}`
    : posix.normalize(posix.join(posix.dirname(f.rel), imp.from));
  return imp.name === "cn" && target === "src/lib/utils";
}

/** The className the tag's LAST writer gives its box, `mount` being the
 *  caller's tokens (null: the caller passes none). An explicit `className`
 *  writes its own tokens, plus the caller's where its `{…}` names them
 *  (conditional when that name sits in a conditional operand), resolved by
 *  `twResolve`; a spread may carry the caller's className, so whenever the
 *  caller passes one it replaces every earlier writer, unless it spreads
 *  `rest`, the props pattern's rest after it took `className` out. Null when
 *  nothing writes. */
function effectiveClass(info, mount, rest = null) {
  let eff = null;
  for (const w of info.writers) {
    if (!w.spread) {
      let toks = w.tokens;
      if (w.forwards && mount) {
        const at = w.forwards.at;
        const caller = w.forwards.cond
          ? mount.map((t) => ({ ...t, cond: true }))
          : mount;
        toks = [
          ...toks.filter((t) => t.at < at),
          ...caller,
          ...toks.filter((t) => t.at > at),
        ];
      }
      eff = twResolve(toks, w.merge);
    } else if (mount && !(rest && w.name === rest)) eff = mount;
  }
  return eff;
}

function transparent(f, node) {
  const n = node.name;
  if (
    n === "" ||
    n === "Fragment" ||
    n === "React.Fragment" ||
    n === "Suspense" ||
    n === "Activity" ||
    /(?:Context|Provider|ErrorBoundary)$/.test(n)
  ) {
    return true;
  }
  // Read on the resolved set, so a later display member that a merge keeps
  // (or the stylesheet may apply) leaves the tag a box; read bare, so an
  // important marker on either end still counts.
  return (
    /^[a-z]/.test(n) &&
    (effectiveClass(classInfo(f, node), null) ?? []).some(
      (t) => !t.cond && readToken(t.tok) === "contents",
    )
  );
}

/** Each transparent tree's children, recursively, as roots. */
function expandRoots(f, t) {
  if (!transparent(f, t)) return [t];
  return t.slots.flatMap((s) =>
    s.kind === "tag"
      ? expandRoots(f, s.node)
      : s.trees.flatMap((x) => expandRoots(f, x)),
  );
}

/** Function-body brace ranges inside (from, to): `=> {`, or `) {` whose `(`
 *  follows anything but a control keyword. */
function fnRanges(masked, from, to) {
  const isFn = (i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(masked[k])) k--;
    if (masked[k] === ">" && masked[k - 1] === "=") return true;
    if (masked[k] !== ")") return false;
    let depth = 0;
    let o = k;
    for (; o >= 0; o--) {
      if (CLOSE.has(masked[o])) depth++;
      else if (OPEN.has(masked[o]) && --depth === 0) break;
    }
    let w = o - 1;
    while (w >= 0 && /\s/.test(masked[w])) w--;
    const word = /[\w$]*$/.exec(masked.slice(Math.max(0, w - 40), w + 1))[0];
    return !CONTROL.has(word) && !BLOCK_WORDS.has(word) && word !== "await";
  };
  const ranges = [];
  const stack = [];
  for (let i = from + 1; i < to; i++) {
    if (masked[i] === "{") stack.push([i, isFn(i)]);
    else if (masked[i] === "}") {
      const top = stack.pop();
      if (top?.[1]) ranges.push([top[0], i]);
    }
  }
  return ranges;
}

/** End of the expression starting at `j`: a `;` or a column-0 line at depth 0,
 *  or the bracket that closes it. */
function exprEnd(masked, j) {
  let depth = 0;
  for (let i = j; i < masked.length; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (
      depth === 0 &&
      (c === ";" || (c === "\n" && /\S/.test(masked[i + 1] ?? "")))
    ) {
      return i;
    }
  }
  return masked.length;
}

const DECL =
  /^(export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*([A-Z][\w$]*)\s*[<(]|const\s+([A-Z][\w$]*)\s*[:=])/gm;

/** The file's component declarations with their roots. */
function componentsOf(f) {
  const { masked, trees } = f;
  const code = trees.filter((t) => !t.inAttr);
  const out = [];
  const exported = new Set();
  for (const m of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const spec of m[1].split(",")) {
      const a = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+[\w$]+)?\s*$/.exec(spec);
      if (a) exported.add(a[1]);
    }
  }
  for (const m of masked.matchAll(DECL)) {
    const name = m[2] ?? m[3];
    let k = m.index + m[0].length - 1;
    let body;
    let params = "";
    if (m[2]) {
      if (masked[k] === "<") k = skipWs(masked, skipAngles(masked, k));
      if (masked[k] !== "(") continue;
      const pc = matchBrace(masked, k);
      if (pc < 0) throw new ScanError(`${name}: unreadable parameters`);
      params = masked.slice(k + 1, pc);
      let b = pc + 1;
      while (b < masked.length && masked[b] !== "{" && masked[b] !== ";") b++;
      if (masked[b] !== "{") continue;
      body = { kind: "block", from: b, to: matchBrace(masked, b), arrow: -1 };
    } else {
      const eq = /=(?![=>])/g;
      eq.lastIndex = k;
      const em = eq.exec(masked);
      if (!em) continue;
      let a = skipWs(masked, em.index + 1);
      if (/^async\b/.test(masked.slice(a))) a = skipWs(masked, a + 5);
      if (masked[a] === "<") a = skipWs(masked, skipAngles(masked, a));
      if (masked[a] === "(") {
        const pc = matchBrace(masked, a);
        if (pc < 0) throw new ScanError(`${name}: unreadable parameters`);
        params = masked.slice(a + 1, pc);
        a = skipWs(masked, pc + 1);
        if (masked[a] === ":") a = masked.indexOf("=>", a);
      } else {
        const p = /^[\w$]+\s*/.exec(masked.slice(a));
        if (!p) continue;
        a += p[0].length;
      }
      if (a < 0 || masked.slice(a, a + 2) !== "=>") continue;
      const j = skipWs(masked, a + 2);
      body =
        masked[j] === "{"
          ? { kind: "block", from: j, to: matchBrace(masked, j), arrow: -1 }
          : { kind: "expr", from: j, to: exprEnd(masked, j), arrow: a };
    }
    if (body.to < 0) throw new ScanError(`${name}: its body never ends`);
    const roots = [];
    if (body.kind === "expr") {
      for (const t of code) {
        if (t.start < body.from || t.start >= body.to) continue;
        if (!/;|=>|\bfunction\b/.test(masked.slice(body.arrow + 2, t.start))) {
          roots.push(...expandRoots(f, t));
        }
      }
    } else {
      const nested = fnRanges(masked, body.from, body.to);
      const returns = [];
      const re = /(?<![\w$.])return(?![\w$])/g;
      re.lastIndex = body.from;
      for (
        let r = re.exec(masked);
        r && r.index < body.to;
        r = re.exec(masked)
      ) {
        returns.push(r.index);
      }
      for (const t of code) {
        if (t.start <= body.from || t.start >= body.to) continue;
        const r = returns.findLast((x) => x < t.start);
        if (r === undefined) continue;
        if (/;|=>|\bfunction\b/.test(masked.slice(r + 6, t.start))) continue;
        if (nested.some(([o, c]) => o < r && r < c)) continue;
        roots.push(...expandRoots(f, t));
      }
    }
    out.push({
      name,
      file: f,
      exported: Boolean(m[1]) || exported.has(name),
      isDefault: /default/.test(m[1] ?? ""),
      roots,
      restWithoutClass: restWithoutClass(params),
    });
  }
  return out;
}

/** The rest binding of a props pattern that takes `className` out
 *  (`{ className, ...rest }`), or null: spreading that rest can't hand the
 *  root the caller's className. */
function restWithoutClass(params) {
  const open = params.indexOf("{");
  if (open < 0 || params.slice(0, open).trim() !== "") return null;
  const close = matchBrace(params, open);
  if (close < 0) return null;
  let rest = null;
  let named = false;
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = params[i];
    if (i === close || (c === "," && depth === 0)) {
      const entry = params.slice(from, i).trim();
      const r = /^\.\.\.\s*([\w$]+)$/.exec(entry);
      if (r) rest = r[1];
      else if (/^className(?![\w$])/.test(entry)) named = true;
      from = i + 1;
    } else if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
  }
  return named ? rest : null;
}

/** `const|let x = (<…>)` bindings, read in place of a bare `{x}` child. */
function bindingsOf(f) {
  const { masked, trees } = f;
  const found = new Map();
  for (const t of trees) {
    if (t.inAttr) continue;
    const pre = /(?:const|let|var)\s+([\w$]+)\s*=\s*\(?\s*$/.exec(
      masked.slice(Math.max(0, t.start - 200), t.start),
    );
    if (!pre || !/^\s*\)?\s*;/.test(masked.slice(t.end))) continue;
    const decls = masked.match(
      new RegExp(
        `\\b(?:const|let|var)\\s+${pre[1].replace(/\$/g, "\\$")}\\b`,
        "g",
      ),
    );
    if (decls?.length === 1) found.set(pre[1], [t]);
  }
  return found;
}

const IMPORT = /\bimport\s+(type\s+)?([\w$\s,{}*]*?)\s*from\s*(["'])/g;

/** Local name -> { from, name } for each value import (`default` for a
 *  default import); the specifier is read from the raw text. */
function importsOf(text, masked) {
  const map = new Map();
  for (const m of masked.matchAll(IMPORT)) {
    if (m[1]) continue;
    const q = m.index + m[0].length - 1;
    const end = masked.indexOf(m[3], q + 1);
    if (end < 0) throw new ScanError("an import specifier never ends");
    const from = text.slice(q + 1, end);
    const braced = /\{([^}]*)\}/.exec(m[2]);
    for (const spec of braced ? braced[1].split(",") : []) {
      const a = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (a) map.set(a[2] ?? a[1], { from, name: a[1] });
    }
    const def = /^\s*([\w$]+)/.exec(m[2].replace(/\{[^}]*\}/, ""));
    if (def) map.set(def[1], { from, name: "default" });
  }
  return map;
}

/** The definitions a mount of `name` in `f` lays out with: the same file's,
 *  else the one its import names (a package import resolves to none), else
 *  every exported definition of that name. A definition with no root found
 *  resolves to none. */
function resolveComps(ix, f, name) {
  const local = f.comps.get(name);
  if (local) return local.roots.length ? [local] : [];
  const imp = f.imports.get(name);
  if (!imp) return ix.byName.get(name) ?? [];
  let base;
  if (imp.from.startsWith("@/")) base = `src/${imp.from.slice(2)}`;
  else if (imp.from.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(f.rel), imp.from));
  } else return [];
  const target = [base, `${base}.tsx`, `${base}/index.tsx`]
    .map((p) => ix.byRel.get(p))
    .find(Boolean);
  const c =
    target &&
    (imp.name === "default"
      ? [...target.comps.values()].find((x) => x.isDefault)
      : target.comps.get(imp.name));
  if (c) return c.roots.length ? [c] : [];
  return ix.byName.get(imp.name) ?? [];
}

/** A parsed file depends on its path and text alone, so the controls re-parse
 *  only the file they swap. */
const PARSED = new Map();

/** Parses the corpus and indexes its components. */
function index(files) {
  const parsed = [];
  for (const [rel, text] of files) {
    const key = `${rel}\n${text}`;
    let f = PARSED.get(key);
    if (!f) {
      try {
        const masked = maskNonCode(text, true);
        f = { rel, text, masked, ...parseJsx(text, masked) };
        // Read before the roots: a root's class reading asks who `cn` is.
        f.imports = importsOf(text, masked);
        f.comps = new Map(componentsOf(f).map((c) => [c.name, c]));
        f.bindings = bindingsOf(f);
      } catch (err) {
        if (err instanceof ScanError) {
          throw new ScanError(`${rel}: ${err.message}`);
        }
        throw err;
      }
      PARSED.set(key, f);
    }
    parsed.push(f);
  }
  const byName = new Map();
  for (const f of parsed) {
    for (const c of f.comps.values()) {
      if (!c.exported || c.roots.length === 0) continue;
      byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    }
  }
  return { parsed, byName, byRel: new Map(parsed.map((f) => [f.rel, f])) };
}

/** The class sets a tag can lay out with: one per root of its component,
 *  `mount` being the className tokens its caller passes (null: none) to the
 *  root of `stack`'s last component. */
function classSets(ix, f, node, mount = null, stack = []) {
  const rest = stack.at(-1)?.restWithoutClass ?? null;
  const own = effectiveClass(classInfo(f, node), mount, rest);
  const set = own ?? [];
  if (/^[a-z]/.test(node.name) || transparent(f, node)) return [set];
  const comps = resolveComps(ix, f, node.name);
  const sets = [];
  for (const c of comps) {
    if (stack.includes(c)) continue;
    for (const r of c.roots) {
      sets.push(...classSets(ix, c.file, r, own, [...stack, c]));
    }
  }
  return sets.length ? sets : [set];
}

/** The value arms of the expression [from, to) of `masked`: both results of a
 *  `?:`, every operand of `||` / `??`, the last operand of `&&`, recursively,
 *  wrapping parens trimmed. `trees` (JSX inside the range) are skipped whole,
 *  so their own `?`, `:` and `&&` never split an arm. */
function valueArms(masked, from, to, trees) {
  let s = skipWs(masked, from);
  let e = to;
  const trimEnd = () => {
    while (e > s && /\s/.test(masked[e - 1])) e--;
  };
  trimEnd();
  while (masked[s] === "(" && matchBrace(masked, s) === e - 1) {
    s = skipWs(masked, s + 1);
    e--;
    trimEnd();
  }
  const ors = [];
  let and = -1;
  let q = -1;
  let colon = -1;
  let pending = 0;
  for (let i = s, depth = 0; i < e; i++) {
    const tree = trees.find((t) => t.start === i);
    if (tree) {
      i = tree.end - 1;
      continue;
    }
    const c = masked[i];
    const two = masked.slice(i, i + 2);
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth !== 0) continue;
    else if (two === "??" || two === "||" || two === "&&") {
      if (q < 0 && two === "&&") and = i;
      else if (q < 0) ors.push(i);
      i++;
    } else if (c === "?" && masked[i + 1] !== ".") {
      if (q < 0) q = i;
      pending++;
    } else if (c === ":" && q >= 0 && --pending === 0) {
      colon = i;
      break;
    }
  }
  const arms = (a, b) => valueArms(masked, a, b, trees);
  if (q >= 0 && colon > q)
    return [...arms(q + 1, colon), ...arms(colon + 1, e)];
  if (q >= 0) return [[s, e]];
  if (ors.length) {
    const cuts = [s - 2, ...ors];
    return cuts.flatMap((c, k) => arms(c + 2, cuts[k + 1] ?? e));
  }
  if (and >= 0) return arms(and + 2, e);
  return [[s, e]];
}

/** Whether a slot can paint in flow beside a rigid node. An expression slot
 *  counts when one of its value arms does: an arm holding JSX by its tags, a
 *  tag-free arm unless blank or a literal that renders nothing, an identifier
 *  bound to JSX as that JSX. */
function slotCounts(ix, f, slot, ctx) {
  if (slot.kind === "text") return true;
  if (slot.kind === "tag") return tagCounts(ix, f, slot.node, ctx);
  const arms = valueArms(f.masked, slot.start + 1, slot.end - 1, slot.trees);
  return arms.some(([s, e]) => {
    const trees = slot.trees.filter((t) => t.start >= s && t.end <= e);
    if (trees.length) return trees.some((t) => tagCounts(ix, f, t, ctx));
    const src = f.masked.slice(s, e);
    if (!src.trim()) return false;
    if (NON_RENDERING.test(f.text.slice(s, e).trim())) return false;
    const id = /^\s*([\w$]+)\s*$/.exec(src);
    const bound = id && f.bindings.get(id[1]);
    return bound ? bound.some((t) => tagCounts(ix, f, t, ctx)) : true;
  });
}

function emptySpan(f, node) {
  if (node.name !== "span" || !node.selfClosing) return false;
  const info = classInfo(f, node);
  return (
    info.literal &&
    !info.spread &&
    !info.style &&
    info.tokens.every((t) => NON_BOX(t.tok))
  );
}

function tagCounts(ix, f, node, ctx) {
  if (ctx.spaceY) return true;
  if (transparent(f, node)) {
    return node.slots.some((s) => slotCounts(ix, f, s, ctx));
  }
  if (ctx.exempt && emptySpan(f, node)) return false;
  return classSets(ix, f, node).some(inFlow);
}

/** The slots beside `node` in `slots`, expanded through transparent nodes;
 *  `path` holds the node and the transparent nodes climbed. */
function siblingSlots(f, slots, path, node) {
  const out = [];
  const walk = (list) => {
    for (const s of list) {
      if (s.kind === "tag") {
        if (s.node === node) continue;
        if (path.has(s.node) || transparent(f, s.node)) walk(s.node.slots);
        else out.push(s);
      } else {
        const on = s.trees.find((t) => path.has(t));
        if (!on) out.push(s);
        else if (on !== node) walk(on.slots);
      }
    }
  };
  walk(slots);
  return out;
}

/** Findings, rigid nodes by tag name and corpus counts. */
function scan(files, { exempt = true } = {}) {
  const ix = index(files);
  const findings = [];
  const rigidByTag = new Map();
  let rigid = 0;
  let components = 0;
  for (const f of ix.parsed) {
    for (const c of f.comps.values()) if (c.roots.length) components++;
  }
  for (const f of ix.parsed) {
    if (f.rel.startsWith(VENDORED)) continue;
    for (const node of f.nodes) {
      if (transparent(f, node)) continue;
      if (!classSets(ix, f, node).some(isRigid)) continue;
      rigid++;
      const tag = node.name;
      rigidByTag.set(tag, (rigidByTag.get(tag) ?? 0) + 1);
      const path = new Set([node]);
      let cur = node;
      let anc = null;
      while (cur.parent) {
        if (!transparent(f, cur.parent)) {
          anc = cur.parent;
          break;
        }
        cur = cur.parent;
        path.add(cur);
      }
      if (!anc && cur === node) continue;
      const host = anc ?? cur;
      const hostSets = anc ? classSets(ix, f, anc) : [];
      const ctx = {
        exempt,
        spaceY: hostSets.some((s) => anyRead(s, /^space-y-/, true)),
      };
      const n = siblingSlots(f, host.slots, path, node).filter((s) =>
        slotCounts(ix, f, s, ctx),
      ).length;
      if (n === 0 || (anc && !hostSets.some(isColumn))) continue;
      findings.push({
        rel: f.rel,
        line: lineOf(f.text, node.start),
        name: node.name,
        n,
      });
    }
  }
  return { findings, rigidByTag, rigid, components };
}

function problems(files, allowlist = ALLOWLIST, opts = {}) {
  if (files.size === 0) return ["the walk read zero files"];
  const { findings, rigid, components } = scan(files, opts);
  const out = [];
  if (components === 0) out.push("no component root resolved");
  if (rigid === 0) out.push("no rigid node found");
  const byFile = Map.groupBy(findings, (x) => x.rel);
  for (const [rel, list] of byFile) {
    const want = allowlist[rel]?.count ?? 0;
    if (list.length === want) continue;
    for (const x of list) out.push(MESSAGE(x.rel, x.line, `<${x.name}>`, x.n));
    if (want > 0) {
      out.push(`${rel}: ${list.length} finding(s), allowlist says ${want}`);
    }
  }
  for (const [rel, entry] of Object.entries(allowlist)) {
    if (!byFile.has(rel)) {
      out.push(
        `${rel}: stale allowlist entry (0 hits, allowlist says ${entry.count})`,
      );
    }
  }
  return out;
}

const breakdown = (files, opts) =>
  [...scan(files, opts).rigidByTag]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => `${tag} ${n}`)
    .join(", ");

const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => rel.endsWith(".tsx") && !rel.startsWith(TESTS)),
);

test("no rigid h-full item sits beside in-flow siblings in a flex column", () => {
  const t0 = performance.now();
  const got = problems(CORPUS);
  const ms = Math.round(performance.now() - t0);
  assert.deepEqual(
    got,
    [],
    `${got.join("\n")}\nrigid nodes by tag (${ms} ms): ${breakdown(CORPUS)}`,
  );
});

test("every allowlist entry carries a rationale and a count", () => {
  for (const [rel, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.rationale.length > 0, rel);
    assert.ok(entry.count > 0, rel);
  }
});

const PR_COMMIT = "src/features/pulls/PrCommitDetail.tsx";
const PLACEHOLDER = "src/features/diff/DiffPlaceholder.tsx";
const SESSION_VIEW = "src/features/sessions/SessionView.tsx";
const PR_ROOT = [
  PR_COMMIT,
  'className="flex min-h-0 flex-1 flex-col outline-none"',
  'className="flex h-full flex-col outline-none"',
];
const PLACEHOLDER_ROOT = [
  PLACEHOLDER,
  "flex h-full min-h-0 flex-col",
  "flex h-full flex-col",
];
/** The real corpus with each `[rel, from, to]` swapped once. */
const swapped = (...swaps) => {
  const files = new Map(CORPUS);
  for (const [rel, from, to] of swaps) {
    const text = files.get(rel);
    assert.equal(text?.split(from).length, 2, `${rel} holds ${from} once`);
    files.set(
      rel,
      text.replace(from, () => to),
    );
  }
  return files;
};
const findingsOf = (files, opts) =>
  scan(files, opts)
    .findings.map((x) => `${x.rel} <${x.name}>`)
    .sort();
const MOUNTS = {
  prCommit: "src/features/pulls/RemotePrView.tsx <PrCommitDetail>",
  placeholder: [
    "src/features/compare/BranchDiffView.tsx <DiffPlaceholder>",
    `${PR_COMMIT} <DiffPlaceholder>`,
    `${PR_COMMIT} <DiffPlaceholder>`,
  ],
};

test("NC0: with both roots unfixed the scan names exactly the four mounts", () => {
  assert.deepEqual(
    findingsOf(swapped(PR_ROOT, PLACEHOLDER_ROOT)),
    [...MOUNTS.placeholder, MOUNTS.prCommit].sort(),
  );
});

test("NC1: PrCommitDetail's root back on h-full flags its RemotePrView mount", () => {
  assert.deepEqual(findingsOf(swapped(PR_ROOT)), [MOUNTS.prCommit]);
});

test("NC2: DiffPlaceholder's root without min-h-0 flags its three mounts", () => {
  assert.deepEqual(findingsOf(swapped(PLACEHOLDER_ROOT)), MOUNTS.placeholder);
});

// SessionChanges' views sit beside its empty landing span in a `contents`
// wrapper each; on the fixed tree its placeholder view is no longer rigid.
test("NC3: without the empty-span exemption SessionChanges' views flag", () => {
  assert.deepEqual(findingsOf(CORPUS, { exempt: false }), [
    `${SESSION_VIEW} <BranchDiffView>`,
    `${SESSION_VIEW} <WorktreeChangesView>`,
  ]);
  assert.deepEqual(
    findingsOf(swapped(PLACEHOLDER_ROOT), { exempt: false }),
    [
      ...MOUNTS.placeholder,
      `${SESSION_VIEW} <BranchDiffView>`,
      `${SESSION_VIEW} <DiffPlaceholder>`,
      `${SESSION_VIEW} <WorktreeChangesView>`,
    ].sort(),
  );
});

// Synthetic corpora. STUB keeps one component root and one rigid node in
// every corpus, so a fixture's only problem is its own.
const STUB = "src/features/zz/Stub.tsx";
const STUB_TEXT =
  'export function Stub() {\n  return <div className="h-full" />;\n}\n';
const REL = "src/features/zz/Host.tsx";
const withFiles = (entries) => new Map([[STUB, STUB_TEXT], ...entries]);
const check = (text, opts) => problems(withFiles([[REL, text]]), {}, opts);
/** A Host whose root is a flex column holding a header and `child`. */
const host = (child, extra = "", column = "flex h-full min-h-0 flex-col") =>
  [
    "export function Host({ children }: { children?: React.ReactNode }) {",
    "  return (",
    `    <div className="${column}">`,
    '      <header className="border-b">title</header>',
    `      ${child}`,
    "    </div>",
    "  );",
    "}",
    extra,
  ].join("\n");
const fails = (text, line = 5, opts) => {
  const got = check(text, opts);
  assert.equal(got.length, 1, `${text}\n---\n${got.join("\n")}`);
  assert.match(got[0], new RegExp(`^${REL}:${line}: `));
};
const passes = (text, opts) => assert.deepEqual(check(text, opts), [], text);

const PANE_BODY = '<div className="flex h-full flex-col">pane</div>';
const FORMS = {
  "export function": `export function Pane() {\n  return ${PANE_BODY};\n}`,
  "export default function": `export default function Pane() {\n  return ${PANE_BODY};\n}`,
  function: `function Pane() {\n  return ${PANE_BODY};\n}`,
  "export const": `export const Pane = () => (\n  ${PANE_BODY}\n);`,
  const: `const Pane = () => ${PANE_BODY};`,
};

test("F1: a rigid-root component beside a header fails in each declaration form", () => {
  for (const [form, decl] of Object.entries(FORMS)) {
    const got = check(host("<Pane />", decl));
    assert.equal(got.length, 1, `${form}: ${got.join("\n")}`);
    assert.match(got[0], /Host\.tsx:5: <Pane> takes its parent's whole height/);
  }
});

test("F1: a declared component in another file resolves when exported", () => {
  const got = problems(
    withFiles([
      [REL, host("<Pane />")],
      ["src/features/zz/Pane.tsx", FORMS["export function"]],
    ]),
  );
  assert.equal(got.length, 1, got.join("\n"));
  const local = problems(
    withFiles([
      [REL, host("<Pane />")],
      ["src/features/zz/Pane.tsx", FORMS.function],
    ]),
  );
  assert.deepEqual(local, []);
});

test("F1: an import picks the definition among same-named ones", () => {
  const files = (from) =>
    withFiles([
      [REL, `import { Pane } from "${from}";\n${host("<Pane />")}`],
      ["src/features/zz/Pane.tsx", FORMS["export function"]],
      [
        "src/features/yy/Pane.tsx",
        'export function Pane() {\n  return <div className="p-2">pane</div>;\n}',
      ],
    ]);
  assert.equal(problems(files("./Pane")).length, 1);
  assert.match(problems(files("@/features/zz/Pane"))[0], /Host\.tsx:6: <Pane>/);
  assert.deepEqual(problems(files("../yy/Pane")), []);
  assert.deepEqual(problems(files("@base-ui/react/pane")), []);
});

test("F1: min-h-0 on the root, a flex-1 min-h-0 root or a min-h-0 flex-1 wrapper passes", () => {
  passes(
    host(
      "<Pane />",
      'function Pane() {\n  return <div className="flex h-full min-h-0 flex-col">pane</div>;\n}',
    ),
  );
  passes(
    host(
      "<Pane />",
      'function Pane() {\n  return <div className="flex min-h-0 flex-1 flex-col">pane</div>;\n}',
    ),
  );
  passes(
    host('<div className="min-h-0 flex-1"><Pane /></div>', FORMS.function),
  );
});

test("F2: a mount's className reaches only a root that reads it", () => {
  const ignores =
    'function Pane(_: { className?: string }) {\n  return <div className="h-full">pane</div>;\n}';
  fails(host('<Pane className="min-h-0" />', ignores));
  passes(
    host(
      '<Pane className="min-h-0" />',
      'function Pane({ className }: { className?: string }) {\n  return <div className={cn("h-full", className)}>pane</div>;\n}',
    ),
  );
  passes(
    host(
      '<Pane className="min-h-0" />',
      'function Pane(props: { className?: string }) {\n  return <div className="h-full" {...props} />;\n}',
    ),
  );
  passes(
    host(
      '<Pane className="h-full" />',
      'function Pane(_: { className?: string }) {\n  return <div className="p-2">pane</div>;\n}',
    ),
  );
});

test("F3: an empty span sibling fails unless every class is non-box", () => {
  const rigid = '<div className="h-full">body</div>';
  const col = (span) =>
    host(`${span}\n      ${rigid}`, "", "flex flex-col").replace(
      '      <header className="border-b">title</header>\n',
      "",
    );
  for (const span of [
    '<span className="m-2" />',
    '<span className="outline-none" style={{ height: 4 }} />',
    '<span className={cn("outline-none")} />',
    '<span className="outline-none" {...rest} />',
    '<span className="h-4" />',
  ]) {
    fails(col(span), 5);
  }
  passes(col('<span tabIndex={-1} className="outline-none" />'));
  passes(
    col("{landing}").replace(
      "  return (",
      '  const landing = (\n    <span ref={(node) => { hold(node); }} role="group" tabIndex={-1} className="outline-none" />\n  );\n  return (',
    ),
  );
  // The column's space-y margin gives every child a box, the span included.
  fails(
    col('<span className="outline-none" />').replace(
      '"flex flex-col"',
      '"flex flex-col space-y-2"',
    ),
    5,
  );
});

test("F4: contents is no box; a contents wrapper alone in a column passes", () => {
  fails(host('<div className="contents"><Pane /></div>', FORMS.function));
  passes(
    host('<div className="contents"><Pane /></div>', FORMS.function).replace(
      '      <header className="border-b">title</header>\n',
      "",
    ),
  );
});

test("F5: an inline h-full fails in a column; a row, a grid or a sole child passes", () => {
  const rigid = '<div className="h-full">body</div>';
  fails(host(rigid));
  passes(host(rigid, "", "flex h-full"));
  passes(host(rigid, "", "grid h-full grid-rows-[auto_1fr]"));
  passes(
    host(rigid).replace(
      '      <header className="border-b">title</header>\n',
      "",
    ),
  );
});

test("F6: out-of-flow, blank and alternate siblings don't count; others do", () => {
  const solo = (sib) =>
    host(`${sib}\n      <div className="h-full">body</div>`).replace(
      '      <header className="border-b">title</header>\n',
      "",
    );
  passes(solo('<span className="sr-only">x</span>'));
  passes(solo('<div className="absolute inset-0" />'));
  passes(solo("{/* a note */}"));
  passes(
    solo("{hint}").replace(
      "  return (",
      '  const hint = <span className="sr-only">x</span>;\n  return (',
    ),
  );
  passes(
    host('{open ? <div className="h-full">a</div> : <p>b</p>}').replace(
      '      <header className="border-b">title</header>\n',
      "",
    ),
  );
  fails(solo("{children}"), 5);
  fails(solo('<span className={open ? "sr-only" : "text-xs"}>x</span>'), 5);
});

test("F7: a fragment handed to a helper fails with several children only", () => {
  const helper = (inner) =>
    [
      "export function Host() {",
      "  const framed = (n: React.ReactNode) => n;",
      `  return framed(${inner});`,
      "}",
    ].join("\n");
  fails(helper('<><header>t</header><div className="h-full">b</div></>'), 3);
  passes(helper('<div className="h-full">b</div>'));
});

test("F8: Suspense, Activity and Context wrappers are climbed through", () => {
  fails(
    host(
      '<Suspense fallback={null}><div className="h-full">b</div></Suspense>',
    ),
  );
  fails(
    host('<Activity mode="visible"><div className="h-full">b</div></Activity>'),
  );
  fails(
    host(
      '<PaneContext value={1}><div className="h-full">b</div></PaneContext>',
    ),
  );
});

test("F9: relief or h-full inside a conditional cn( reads both ways", () => {
  fails(host('<div className={cn("h-full", open && "min-h-0")}>b</div>'));
  fails(host('<div className={cn("p-2", open && "h-full")}>b</div>'));
  fails(host('<div className={cn(open && "h-full")}>b</div>'));
  fails(host('<div className={open ? "h-full min-h-0" : "h-full"}>b</div>'));
  fails(host('<div className={cn("h-full", { "min-h-0": open })}>b</div>'));
  fails(
    host('<div className={cn("h-full", open ? cn("min-h-0") : "")}>b</div>'),
  );
  // Only a conditional operand's literals are conditional: a plain argument
  // beside one keeps its relief.
  passes(
    host('<div className={cn("h-full min-h-0", open && "border")}>b</div>'),
  );
  passes(host('<div className={cn("h-full min-h-0")}>b</div>'));
  passes(
    host('<div className={`h-full min-h-0 ${open ? "p-2" : ""}`}>b</div>'),
  );
});

test("F15: non-blank JSX text beside an h-full child counts; blank text doesn't", () => {
  const rigid = '<div className="h-full">body</div>';
  const solo = (sib) =>
    host(`${sib}\n      ${rigid}`).replace(
      '      <header className="border-b">title</header>\n',
      "",
    );
  fails(solo("Loading"), 5);
  fails(solo("&nbsp;"), 5);
  fails(
    host(`${rigid}\n      tail text`).replace(
      '      <header className="border-b">title</header>\n',
      "",
    ),
    4,
  );
  passes(solo(""));
  passes(solo("{' '}"));
});

test("F16: a spread forwards the caller's className only when nothing overrides it", () => {
  const pane = (attrs) =>
    `function Pane(props: { className?: string }) {\n  return <div ${attrs}>pane</div>;\n}`;
  fails(
    host('<Pane className="min-h-0" />', pane('{...props} className="h-full"')),
  );
  passes(
    host('<Pane className="min-h-0" />', pane('className="h-full" {...props}')),
  );
  passes(
    host(
      '<Pane className="min-h-0" />',
      pane('{...props} className={cn("h-full", props.className)}'),
    ),
  );
  fails(
    host(
      '<Pane className="min-h-0" />',
      pane('{...props} className={cn("h-full", other.className)}'),
    ),
  );
});

test("F18: only the root's last className writer counts", () => {
  // Cells: the caller passes min-h-0 to a root writing h-full, h-full to one
  // writing min-h-0, or nothing to one writing h-full. A spread replaces what
  // came before whenever the caller passes a className, except the rest of a
  // props pattern that took `className` out.
  const P = "{ className?: string }";
  const forms = {
    "explicit before spread": ["props", 'className="R" {...props}', "pff"],
    "spread before explicit": ["props", '{...props} className="R"', "fpf"],
    "explicit merging the caller": [
      "{ className }",
      'className={cn("R", className)}',
      "ppf",
    ],
    "props.className": ["props", 'className={cn("R", props.className)}', "ppf"],
    "two spreads, a spread last": [
      "props",
      'className="R" {...extra} {...props}',
      "pff",
    ],
    "two spreads, explicit last": [
      "props",
      '{...extra} {...props} className="R"',
      "fpf",
    ],
    "the rest without className": [
      "{ className, ...rest }",
      'className="R" {...rest}',
      "fpf",
    ],
    "a rest that keeps className": [
      "{ style, ...rest }",
      'className="R" {...rest}',
      "pff",
    ],
    "merging, then the rest": [
      "{ className, ...rest }",
      'className={cn("R", className)} {...rest}',
      "ppf",
    ],
    "merging props.className, then props": [
      "props",
      'className={cn("R", props.className)} {...props}',
      "pff",
    ],
  };
  const cells = [
    ['<Pane className="min-h-0" />', "h-full"],
    ['<Pane className="h-full" />', "min-h-0"],
    ["<Pane />", "h-full"],
  ];
  for (const [form, [param, attrs, verdicts]] of Object.entries(forms)) {
    cells.forEach(([mount, root], i) => {
      const pane = `function Pane(${param}: ${P}) {\n  return <div ${attrs.replace('"R"', `"${root}"`)}>pane</div>;\n}`;
      const text = host(mount, pane);
      const got = check(text);
      const want = verdicts[i] === "f" ? 1 : 0;
      assert.equal(got.length, want, `${form} / ${mount}\n${got.join("\n")}`);
      if (want) assert.match(got[0], new RegExp(`^${REL}:5: `));
    });
  }
});

test("F17: a child expression that renders nothing is no sibling", () => {
  const solo = (sib) =>
    host(`${sib}\n      <div className="h-full">body</div>`).replace(
      '      <header className="border-b">title</header>\n',
      "",
    );
  for (const sib of ["{null}", "{ undefined }", "{false}", "{true}", '{""}']) {
    passes(solo(sib));
  }
  fails(solo('{"text"}'), 5);
  fails(solo("{label}"), 5);
});

test("F10: a variant-only flex-col parent, attribute trees and generics pass", () => {
  passes(
    host(
      '<div className="h-full">b</div>',
      "",
      "flex has-[>textarea]:flex-col",
    ),
  );
  passes(host('<Labelled icon={<div className="h-full" />} />'));
  passes(
    host(
      '<div className="p-2">b</div>',
      "const pick = <K extends string>(k: K) => k;\nconst first = <T,>(xs: T[]) => xs[0];",
    ),
  );
});

test("F11: zero files, no root, no rigid node or an unclosed tag fail closed", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  assert.deepEqual(
    problems(new Map([[REL, 'const node = <div className="h-full" />;\n']])),
    ["no component root resolved"],
  );
  assert.deepEqual(
    problems(
      new Map([
        [REL, 'export function A() {\n  return <div className="p-2" />;\n}\n'],
      ]),
    ),
    ["no rigid node found"],
  );
  assert.throws(
    () =>
      check('export function A() {\n  return <div className="h-full">;\n}\n'),
    ScanError,
  );
  assert.throws(
    () => loadCorpus([[REL, `const a = 1;${String.fromCharCode(0)}\n`]]),
    ScanError,
  );
});

test("F12: a stale allowlist row and a drifted count fail", () => {
  const stale = problems(
    withFiles([[REL, host('<div className="p-2">b</div>')]]),
    {
      [REL]: { count: 1, rationale: "x" },
    },
  );
  assert.deepEqual(stale, [
    `${REL}: stale allowlist entry (0 hits, allowlist says 1)`,
  ]);
  const drift = problems(
    withFiles([[REL, host('<div className="h-full">b</div>')]]),
    {
      [REL]: { count: 2, rationale: "x" },
    },
  );
  assert.equal(drift.length, 2, drift.join("\n"));
  assert.match(drift[1], /Host\.tsx: 1 finding\(s\), allowlist says 2/);
  const held = problems(
    withFiles([[REL, host('<div className="h-full">b</div>')]]),
    {
      [REL]: { count: 1, rationale: "x" },
    },
  );
  assert.deepEqual(held, []);
});

/** Whether `run` throws a ScanError whose message matches `re`. */
const throwsArm = (run, re) =>
  assert.throws(
    run,
    (err) => err instanceof ScanError && re.test(err.message),
    String(re),
  );
const inA = (jsx) => `export function A() {\n  return ${jsx};\n}\n`;

test("F13: each unreadable construct fails closed with its own message", () => {
  // CONTRACT: a `className` value running past its tag.
  throwsArm(
    () => check(inA("<div className=<b /> />")),
    /a className value runs past its tag/,
  );
  throwsArm(
    () => check(inA('<div className="h-full" a={(}>x</div>')),
    /an attribute never ends/,
  );
  throwsArm(
    () => check(inA('<div className="h-full">{((}</div>')),
    /a child expression never ends/,
  );
  throwsArm(
    () =>
      check(
        'export function A<T(props: T) {\n  return <div className="h-full" />;\n}\n',
      ),
    /unreadable type parameters/,
  );
  throwsArm(
    () =>
      check(
        'export function A((props) {\n  return <div className="h-full" />;\n}\n',
      ),
    /A: unreadable parameters/,
  );
  throwsArm(
    () =>
      check('export function A() {\n  return <div className="h-full" />;\n'),
    /A: its body never ends/,
  );
  // On real source the masker answers these two first (it blanks JSX text and
  // refuses an open string), so they are reached with unmasked text.
  const child = "<div><b>(x)</b></div>;\n";
  throwsArm(() => parseJsx(child, child), /unreadable JSX child/);
  const open = 'import { a } from "x';
  throwsArm(() => importsOf(open, open), /an import specifier never ends/);
});

test("F14: a const arrow whose parameter list never closes fails closed", () => {
  throwsArm(
    () => check('const Pane = ((props) => <div className="h-full" />;\n'),
    /Pane: unreadable parameters/,
  );
});

const CN = 'import { cn } from "@/lib/utils";\n';
/** A Host mounting `<Pane className=…>` beside its header, Pane's root
 *  writing `rootClass`; cn imported from src/lib/utils. */
const paneMount = (mount, rootClass, param = "{ className }") =>
  CN +
  host(
    `<Pane className="${mount}" />`,
    `function Pane(${param}: { className?: string }) {\n  return <div className={${rootClass}}>pane</div>;\n}`,
  );

test("F19: a merged className keeps each read group's last member", () => {
  const root = 'cn("h-full min-h-0", className)';
  // The caller's min-height replaces the root's min-h-0.
  for (const mount of ["min-h-full", "min-h-screen", "min-h-[40px]", "min-h-4"])
    fails(paneMount(mount, root), 6);
  fails(paneMount("!min-h-full", root), 6);
  passes(paneMount("min-h-0", root));
  passes(paneMount("p-2 md:min-h-full", root));
  // The root's own min-h-0 comes last and wins.
  passes(paneMount("min-h-full", 'cn(className, "h-full min-h-0")'));
  // A conditional caller may replace it, and its own relief is conditional.
  fails(paneMount("min-h-full", 'cn("h-full min-h-0", open && className)'), 6);
  fails(paneMount("min-h-0", 'cn("h-full", open && className)'), 6);
  passes(paneMount("min-h-0", 'cn("h-full", className)'));
  // The other relief groups: overflow and position.
  fails(
    paneMount("overflow-visible", 'cn("h-full overflow-auto", className)'),
    6,
  );
  fails(
    paneMount("overflow-visible", 'cn("h-full overflow-y-auto", className)'),
    6,
  );
  fails(paneMount("relative", 'cn("h-full absolute", className)'), 6);
  // The fill group: a caller's height replaces h-full, so nothing is rigid.
  passes(paneMount("h-auto", 'cn("h-full", className)'));
  fails(paneMount("size-full", 'cn("h-4", className)'), 6);
  // Unmerged, the stylesheet's order decides: neither min-height counts.
  fails(paneMount("min-h-full", "`h-full min-h-0 ${className}`"), 6);
  fails(CN + host('<div className="h-full min-h-0 min-h-full">b</div>'), 6);
  fails(paneMount("min-h-full", 'clsx("h-full min-h-0", className)'), 6);
  fails(
    paneMount("min-h-full", 'cn("h-full min-h-0", className)').replace(CN, ""),
    5,
  );
  // One merged value with no caller.
  passes(CN + host('<div className={cn("min-h-full h-full min-h-0")}>b</div>'));
  fails(
    CN +
      host(
        '<div className={cn("h-full min-h-0", open && "min-h-full")}>b</div>',
      ),
    6,
  );
});

test("F20: each value arm of a child expression is a slot alternative", () => {
  const solo = (sib) =>
    host(`${sib}\n      <div className="h-full">body</div>`).replace(
      '      <header className="border-b">title</header>\n',
      "",
    );
  const abs = '<span className="absolute" />';
  for (const sib of [
    `{busy ? "Loading" : ${abs}}`,
    `{busy ? ${abs} : "Loading"}`,
    `{busy ? ${abs} : \`\${n} left\`}`,
    '{busy && "Loading"}',
    `{a ? ${abs} : b ? "Loading" : null}`,
    `{(busy) ? (${abs}) : (label)}`,
    "{busy ? <>Loading</> : null}",
    '{label ?? <span className="sr-only">x</span>}',
    `{error || ${abs}}`,
    `{a && b ? null : c || "x"}`,
  ]) {
    fails(solo(sib), 5);
  }
  for (const sib of [
    `{busy ? null : ${abs}}`,
    `{busy ? "" : ${abs}}`,
    '{busy && <span className="sr-only">x</span>}',
    `{count && ${abs}}`,
    `{a ? ${abs} : b ? null : undefined}`,
    '{a ? <svg xlink:href="#x" className="absolute" /> : null}',
  ]) {
    passes(solo(sib));
  }
});

test("F21: an h-full box that is itself out of flow is not rigid", () => {
  // Unconditionally hidden or out of flow, it takes no space in the column.
  passes(host('<div className="hidden h-full" />'));
  passes(host('<div className="h-full hidden">b</div>'));
  passes(host('<div className="sr-only h-full">b</div>'));
  passes(CN + host('<div className={cn("flex h-full", "hidden")}>b</div>'));
  passes(paneMount("hidden", 'cn("flex h-full", className)'));
  // A conditional, variant or overridden `hidden` leaves it rigid.
  fails(host('<div className={open ? "hidden h-full" : "h-full"}>b</div>'));
  fails(
    CN + host('<div className={cn("h-full", open && "hidden")}>b</div>'),
    6,
  );
  fails(CN + host('<div className={cn("hidden h-full", "flex")}>b</div>'), 6);
  fails(host('<div className="hidden flex h-full">b</div>'));
  fails(host('<div className="md:hidden h-full">b</div>'));
  fails(paneMount("flex", 'cn("hidden h-full", className)'), 6);
});

test("F22: contents is read after resolution, as a box's other classes are", () => {
  // A merged later display member drops `contents`: the tag is a box again.
  fails(
    CN + host('<div className={cn("contents", "block h-full")}>b</div>'),
    6,
  );
  fails(paneMount("block h-full", 'cn("contents", className)'), 6);
  // Unmerged, the stylesheet decides, so the tag may be a box.
  fails(host('<div className="contents block h-full">b</div>'));
  // A merged LAST `contents` still has no box: its children are climbed to.
  fails(
    CN +
      host(
        '<div className={cn("block", "contents")}><Pane /></div>',
        FORMS.function,
      ),
    6,
  );
  passes(
    CN + host('<div className={cn("block h-full", "contents")}><span /></div>'),
  );
});

for (const tok of ["contents!", "!contents"]) {
  test(`F23: an important contents (${tok}) is still no box`, () => {
    const wrapper = `<div className="${tok}"><div className="h-full" /></div>`;
    fails(host(wrapper));
    passes(
      host(wrapper).replace(
        '      <header className="border-b">title</header>\n',
        "",
      ),
    );
  });
}

/** The installed tailwind-merge, or null where node_modules is absent (the
 *  guards job runs this file without it). */
const TW_MERGE = await import("tailwind-merge")
  .then((m) => m.twMerge)
  .catch(() => null);

test("the modelled groups agree with the installed tailwind-merge", {
  skip: TW_MERGE ? false : "tailwind-merge is not installed",
}, () => {
  const probes = [
    ...["block", "flex", "inline-flex", "grid", "hidden", "contents"],
    ...["sr-only", "not-sr-only", "absolute", "relative", "fixed", "sticky"],
    ...[
      "overflow-auto",
      "overflow-hidden",
      "overflow-visible",
      "overflow-clip",
    ],
    ...["overflow-y-auto", "overflow-y-scroll", "overflow-y-visible"],
    ...[
      "overflow-x-auto",
      "flex-col",
      "flex-row",
      "flex-col-reverse",
      "flex-1",
    ],
    ...["min-h-0", "min-h-full", "min-h-screen", "min-h-none", "min-h-lh"],
    ...["min-h-[10px]", "min-h-(--x)", "min-h-4", "min-h-0.5", "min-h-1/2"],
    ...["min-h-dvh", "min-h-fit", "min-h-px", "h-full", "h-auto", "h-4"],
    ...["h-px", "h-[3px]", "h-(--h)", "h-screen", "h-1/2", "h-fit", "h-lh"],
    ...["h-svh", "size-full", "size-4", "size-auto", "w-full", "max-h-full"],
    ...["h-foo", "min-h-foo", "overflow-foo", "md:min-h-full", "md:h-full"],
  ];
  const grouped = probes.filter((p) => twGroup(p));
  assert.ok(grouped.length > 40, `${grouped.length} grouped probes`);
  const misses = [];
  for (const x of probes) {
    for (const y of probes) {
      if (x === y) continue;
      const kept = new Set(TW_MERGE(`${x} ${y}`).split(" "));
      const mine = new Set(
        twResolve(
          [
            { tok: x, cond: false },
            { tok: y, cond: false },
          ],
          true,
        ).map((t) => t.tok),
      );
      for (const t of [x, y]) {
        if (twGroup(t) && kept.has(t) !== mine.has(t))
          misses.push(`${x} ${y}: ${t}`);
      }
    }
  }
  assert.deepEqual(misses, []);
  // tailwind-merge keeps both members across importance; the stylesheet's
  // `!important` decides, which the model applies.
  assert.equal(TW_MERGE("min-h-0 !min-h-full"), "min-h-0 !min-h-full");
  assert.deepEqual(
    twResolve(
      [
        { tok: "min-h-0", cond: false },
        { tok: "!min-h-full", cond: false },
      ],
      true,
    ).map((t) => t.tok),
    ["!min-h-full"],
  );
});
