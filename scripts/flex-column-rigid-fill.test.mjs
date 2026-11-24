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
//   `className={…}` expression holds `?`, `&&` or `||`.
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
// - A mount's own tokens reach a root only when that root reads `className`
//   (its `className={…}` names the identifier, or the tag takes a spread);
//   elsewhere they are not read at all. A component with no root found is
//   read by its mount's tokens alone.
// - RIGID: a class set holds `h-full` or `size-full` (conditional counts) and
//   no unconditional `min-h-0`, `overflow(-y)-auto|scroll|hidden`, `absolute`
//   or `fixed`.
// - Transparent nodes, climbed through for parents and expanded for roots and
//   siblings: fragments, `Fragment`, `React.Fragment`, `Suspense`, `Activity`,
//   names ending `Context`, `Provider` or `ErrorBoundary`, and a lowercase tag
//   with an unconditional `contents`.
// - Siblings: the other child slots of the first non-transparent ancestor (one
//   direct child tag, or one top-level `{…}` child expression whose alternates
//   are one slot). A slot counts when it can paint in flow: a tag with a class
//   set free of an unconditional `absolute`, `fixed`, `sr-only` or `hidden`; a
//   tag-free expression that is not blank, a bare identifier bound once in the
//   file to JSX being read as that JSX. A self-closing `<span … />` with no
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
// Out of sight: classes from constants, props, template strings or spreads;
// variant-prefixed classes; a component that lays `children` out in an inner
// column (only its root is read); a root returned any other way (`memo` /
// `forwardRef` call forms); a component reached through `lazy()` (the
// DiffSurfaceLazy wrappers) or the scan can't resolve, whose mount classes
// are taken as its box's; a parentless tag handed to a helper the component
// returns (`return shell(<X />)`), read as a root whatever the helper wraps
// it in; a root that receives `className` under
// another prop name, or forwards it through a local (`const base = cn(…,
// className)`), read as "not read", which drops a mount's `h-full` (one live
// instance, src/features/actions/status.tsx, an icon); a rigid tag bound to a
// local and placed by name (read where it is written); whether an unfollowed
// container really is a column; a block (non-flex) parent of definite height;
// a `gap-*` the column adds around an empty span; a conditional or variant
// `contents`; a `{items.map(…)}` expression is one slot, so repeated rigid
// items never count as siblings of each other; whether the content can
// actually outgrow the space.
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
  literalText,
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

const anyRead = (set, re, uncond = false) =>
  set.some((t) => (!uncond || !t.cond) && re.test(readToken(t.tok)));
const isRigid = (set) => anyRead(set, FILL) && !anyRead(set, RELIEF, true);
const inFlow = (set) => !anyRead(set, OUT_OF_FLOW, true);
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
      } else j++;
    }
  }

  codeTrees(0, masked.length, (t) => trees.push(t), false);
  return { nodes, trees };
}

/** The tag's `className` reading: tokens (with their conditional flag),
 *  whether it is absent or one plain string literal, whether the root reads a
 *  mount's `className`, and its spread / `style`. */
function classInfo(f, node) {
  if (node.cls) return node.cls;
  const { text, masked } = f;
  const [s, e] = node.open;
  const tokens = [];
  let values = 0;
  let literal = true;
  let reads = false;
  const re = /\sclassName\s*=\s*/g;
  re.lastIndex = s;
  for (let m = re.exec(masked); m && m.index < e; m = re.exec(masked)) {
    if (!topLevel(masked, s, m.index)) continue;
    const v = m.index + m[0].length;
    let end = -1;
    let cond = false;
    if (masked[v] === '"' || masked[v] === "'") {
      end = masked.indexOf(masked[v], v + 1) + 1;
    } else if (masked[v] === "{") {
      end = matchBrace(masked, v) + 1;
      const expr = masked.slice(v, end);
      cond = /\?|&&|\|\|/.test(expr);
      literal = false;
      if (/(?<![\w$.])className(?![\w$])/.test(expr)) reads = true;
    }
    if (end <= v || end > e) {
      throw new ScanError(
        `a className value runs past its tag at line ${lineOf(text, s)}`,
      );
    }
    values++;
    for (const tok of literalText(text, masked, v, end).split(/\s+/)) {
      if (tok) tokens.push({ tok, cond });
    }
  }
  const spread = hasSpread(masked, s, e);
  const style = [...masked.slice(s, e).matchAll(/\sstyle\s*=/g)].some((m) =>
    topLevel(masked, s, s + m.index),
  );
  node.cls = {
    tokens,
    literal: values === 0 || (values === 1 && literal),
    reads: reads || spread,
    spread,
    style,
  };
  return node.cls;
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
  return (
    /^[a-z]/.test(n) &&
    classInfo(f, node).tokens.some((t) => !t.cond && t.tok === "contents")
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
    if (m[2]) {
      if (masked[k] === "<") k = skipWs(masked, skipAngles(masked, k));
      if (masked[k] !== "(") continue;
      const pc = matchBrace(masked, k);
      if (pc < 0) throw new ScanError(`${name}: unreadable parameters`);
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
    });
  }
  return out;
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
        f.comps = new Map(componentsOf(f).map((c) => [c.name, c]));
        f.bindings = bindingsOf(f);
        f.imports = importsOf(text, masked);
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
 *  `mount` being the tokens a mount hands a root that reads `className`. */
function classSets(ix, f, node, mount = null, stack = []) {
  const info = classInfo(f, node);
  const own = mount && info.reads ? [...mount, ...info.tokens] : info.tokens;
  if (/^[a-z]/.test(node.name) || transparent(f, node)) return [own];
  const comps = resolveComps(ix, f, node.name);
  const sets = [];
  for (const c of comps) {
    if (stack.includes(c)) continue;
    for (const r of c.roots) {
      sets.push(...classSets(ix, c.file, r, own, [...stack, c]));
    }
  }
  return sets.length ? sets : [own];
}

/** Whether a slot can paint in flow beside a rigid node. */
function slotCounts(ix, f, slot, ctx) {
  if (slot.kind === "tag") return tagCounts(ix, f, slot.node, ctx);
  if (slot.trees.length)
    return slot.trees.some((t) => tagCounts(ix, f, t, ctx));
  const src = f.masked.slice(slot.start + 1, slot.end - 1);
  if (!src.trim()) return false;
  const id = /^\s*([\w$]+)\s*$/.exec(src);
  const bound = id && f.bindings.get(id[1]);
  return bound ? bound.some((t) => tagCounts(ix, f, t, ctx)) : true;
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
  // The whole expression is conditional, so its relief reads conditional too.
  fails(host('<div className={cn("h-full min-h-0", open && "p-2")}>b</div>'));
  passes(host('<div className={cn("h-full min-h-0")}>b</div>'));
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
