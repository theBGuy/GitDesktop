// Shared TypeScript/TSX masking and source traversal for the networkmode guards.
// Runs in CI's installless guards job, so node built-ins ONLY.
// Known false ambiguities: a `<const T,>` generic arrow lexes as JSX and a
// function-typed JSX prop's type argument is unreadable; both fail closed.
// Postfix `x++ / y` / `x-- / y` division lexes as a regex opener: it fails
// closed only when nothing later on the line closes it, else the code between is
// blanked silently. A regex right after a brace-less `if (…)`/`while (…)`/
// `for (…)` lexes as a division.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export class ScanError extends Error {}

export const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Punctuation after which an expression starts, so a `/` opens a regex literal
 *  and, in .tsx, a `<` opens a JSX element. */
export const EXPR_OPENERS = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
/** Keywords after which an expression starts. All but `of` are reserved words in
 *  a module (`yield` and `await` too, modules being strict), so none can be a
 *  name; `of` is contextual and `maskNonCode` checks its position. Contextual
 *  words that never precede an expression here (`async`, `let`, `get`, …) are
 *  left out on purpose. */
export const EXPR_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "else",
  "do",
]);

/** `src` with comment bodies, string / template / regex text, and JSX text blanked
 *  to spaces, every offset and newline kept, so braces or keys inside text can't steer
 *  the scan. JSX (`jsx`, for .tsx) is walked as markup with its `{…}` expressions
 *  lexed as code. An unreadable construct throws: a scan that can't tell code from
 *  text refuses rather than guesses. */
export function maskNonCode(src, jsx) {
  const out = src.split("");
  // A leading byte-order mark is blanked in place, so offsets stay put.
  const BOM = String.fromCharCode(0xfeff);
  if (out[0] === BOM) out[0] = " ";
  const blank = (from, to) => {
    for (let k = from; k < to; k++)
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const fail = (what, at) => {
    throw new ScanError(`${what} at line ${lineOf(src, at)}`);
  };
  // `of` is a keyword only after a for-of binding (`for (const x of …)`, a `]`
  // or `}` pattern); anywhere else it is an ordinary name (`of / 2`).
  const ofIsKeyword = (s) => {
    let k = s - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return false;
    if (out[k] === "]" || out[k] === "}") return true;
    if (!/[\w$]/.test(out[k])) return false;
    let w = k;
    while (w > 0 && /[\w$]/.test(out[w - 1])) w--;
    // A reserved word before it rules the binding out. A preceding `of` counts as
    // the for-of target only right after `const`/`let`/`var` or `(` (`for (const
    // of of …)`), or after `.` as a member target (`for (obj.of of …)`); after
    // anything else it is the keyword, and this `of` is a name.
    const prev = out.slice(w, k + 1).join("");
    if (prev !== "of") return !EXPR_KEYWORDS.has(prev);
    let b = w - 1;
    while (b >= 0 && /\s/.test(out[b])) b--;
    if (b < 0) return false;
    if (out[b] === "(" || out[b] === ".") return true;
    let d = b;
    while (d > 0 && /[\w$]/.test(out[d - 1])) d--;
    return ["const", "let", "var"].includes(out.slice(d, b + 1).join(""));
  };
  // Reads the already-masked text backwards, so comments and string bodies
  // before `i` can't pose as the previous token.
  const exprStartAt = (i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    if (/[\w$]/.test(out[k])) {
      let s = k;
      while (s > 0 && /[\w$]/.test(out[s - 1])) s--;
      // A keyword-named property (`size.in / 2`) is an operand, not a keyword;
      // a spread's `...` before a keyword is not a property access.
      if (out[s - 1] === "." && out[s - 2] !== ".") return false;
      const word = out.slice(s, k + 1).join("");
      if (word === "of") return ofIsKeyword(s);
      return EXPR_KEYWORDS.has(word);
    }
    // A run of `!` hard after an operand (a name, a closing bracket, a
    // template's backtick) is TS's postfix non-null assertion (`total! / 2`,
    // `x!! / 2`, `count! < 3`), so what follows is an operator.
    if (out[k] === "!") {
      let s = k;
      while (s > 0 && out[s - 1] === "!") s--;
      if (s > 0 && /[\w$)\]`]/.test(out[s - 1])) return false;
    }
    return EXPR_OPENERS.has(out[k]);
  };

  const quoted = (start, multiline) => {
    const q = src[start];
    for (let j = start + 1; j < src.length; j++) {
      if (src[j] === "\\" && !multiline) {
        j++;
        // A line continuation over CRLF escapes the whole break.
        if (src[j] === "\r" && src[j + 1] === "\n") j++;
        continue;
      }
      if (src[j] === q) {
        blank(start + 1, j);
        return j + 1;
      }
      if (src[j] === "\n" && !multiline) break;
    }
    return fail("unterminated string", start);
  };

  const regex = (start) => {
    let inClass = false;
    for (let j = start + 1; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "\n") break;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        blank(start + 1, j);
        let k = j + 1;
        while (k < src.length && /[a-z]/i.test(src[k])) k++;
        return k;
      }
    }
    return fail("unterminated regex literal", start);
  };

  const template = (start) => {
    let i = start + 1;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        return i + 1;
      } else if (c === "$" && src[i + 1] === "{") {
        i = code(i + 2, true) + 1;
      } else {
        blank(i, i + 1);
        i++;
      }
    }
    return fail("unterminated template literal", start);
  };

  const skipWs = (i) => {
    while (i < src.length && /\s/.test(src[i])) i++;
    return i;
  };

  /** Skips whitespace and comments between JSX attributes. */
  const skipGap = (i) => {
    for (;;) {
      i = skipWs(i);
      if (src[i] === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        blank(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
      } else if (src[i] === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) return fail("unterminated block comment", i);
        blank(i, end + 2);
        i = end + 2;
      } else return i;
    }
  };

  /** A JSX element or fragment opening at `start` (a `<`); returns the index past
   *  it. A TS generic arrow's type parameters (`<T,>` / `<T extends X>`) are not
   *  JSX: those return `start + 1` so the caller reads them on as code. */
  const element = (start) => {
    let i = skipWs(start + 1);
    const name = /^[\w$.:-]*/.exec(src.slice(i))[0];
    i += name.length;
    if (name && /^\s*(,|extends\b)/.test(src.slice(i))) return start + 1;
    // Type arguments on the tag (`<Select<Item, true>`); an arrow's `=>` inside
    // them is not a closing angle.
    if (name && src[i] === "<") {
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === "<") depth++;
        else if (src[i] === ">" && src[i - 1] !== "=" && --depth === 0) break;
      }
      if (depth !== 0) return fail("unreadable JSX type arguments", start);
      i++;
    }
    // Attributes, then `/>` or `>`; a fragment has no name and no attributes.
    for (;;) {
      i = skipGap(i);
      const c = src[i];
      if (c === "/" && src[i + 1] === ">") return i + 2;
      if (c === ">") break;
      if (!name || i >= src.length) return fail("unreadable JSX tag", start);
      if (c === "{") {
        i = code(i + 1, true) + 1;
        continue;
      }
      const attr = /^[\w$:-]+/.exec(src.slice(i));
      if (!attr) return fail("unreadable JSX attribute", i);
      i = skipWs(i + attr[0].length);
      if (src[i] !== "=") continue;
      i = skipWs(i + 1);
      if (src[i] === '"' || src[i] === "'") i = quoted(i, true);
      else if (src[i] === "{") i = code(i + 1, true) + 1;
      else if (src[i] === "<") i = element(i);
      else return fail("unreadable JSX attribute value", i);
    }
    // Children: text is blanked, `{…}` is code, `<` opens a child or the close tag.
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") {
        i = code(i + 1, true) + 1;
      } else if (c === "<") {
        const next = skipWs(i + 1);
        if (src[next] === "/") {
          const end = src.indexOf(">", next);
          if (end === -1) return fail("unterminated JSX closing tag", i);
          return end + 1;
        }
        i = element(i);
      } else {
        blank(i, i + 1);
        i++;
      }
    }
    return fail("unterminated JSX element", start);
  };

  /** Walks code from `i`; with `inExpr` (a template `${…}` or JSX `{…}`) it returns
   *  the index of the `}` that closes the expression. */
  function code(i, inExpr) {
    const opened = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? src.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === "/" && n === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) fail("unterminated block comment", i);
        blank(i, end + 2);
        i = end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i = quoted(i, false);
        continue;
      }
      if (c === "`") {
        i = template(i);
        continue;
      }
      if (c === "/" && exprStartAt(i)) {
        i = regex(i);
        continue;
      }
      if (jsx && c === "<" && exprStartAt(i)) {
        i = element(i);
        continue;
      }
      if (inExpr) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    if (inExpr) fail("unterminated `{…}` expression", opened);
    return i;
  }

  code(0, false);
  return out.join("");
}

export const OPEN = new Set(["(", "[", "{"]);
export const CLOSE = new Set([")", "]", "}"]);

/** Index of the `}` matching the `{` at `open`, or -1. */
export function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (OPEN.has(masked[i])) depth++;
    else if (CLOSE.has(masked[i]) && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `>` closing the JSX opening tag that starts at `start` in
 *  masked text: the first `>` at brace depth 0, or -1. */
export function tagEnd(masked, start) {
  let depth = 0;
  for (let i = start + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}
