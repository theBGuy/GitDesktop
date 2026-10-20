import type { HLJSApi, Language, LanguageFn, Mode } from "highlight.js";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";

/**
 * A JSX-less `typescript` for highlight.js. The stock grammar inherits
 * javascript's JSX mode, whose `hasClosingTag` accepts `<T>` as a tag when
 * `</T` appears ANYWHERE later in the input (strings included), so one generic
 * plus a later `"</Title>"` turns the rest of a `.ts` file into unhighlighted
 * xml text. A `.ts` file can't contain JSX, so dropping the mode loses nothing.
 * Each typescript, tsx, and javascript grammar also handles comments and regex
 * literals in its params brace and template-substitution modes.
 *
 * Must stay free of aliased and app imports:
 * scripts/ts-no-jsx-highlight.test.mjs loads it directly under Node's type
 * stripping, where `@/` paths don't resolve.
 */

// Registry symbols keep both grammar marks stable across HMR re-evaluation.
const TS_NO_JSX = Symbol.for("gd.hljs.tsNoJsx");
const JS_PARAMS_COMMENT = Symbol.for("gd.hljs.jsParamsComment");

/** javascript.js's JSX mode: an `xml` sub-language entered through fragment /
 *  tag variants. html`` templates embed xml through `starts` and are kept. */
function isJsxMode(mode: unknown): boolean {
  if (!mode || typeof mode !== "object") return false;
  const m = mode as Mode;
  return m.subLanguage === "xml" && Array.isArray(m.variants);
}

/** Remove every JSX mode reachable from `root` (matched by shape, never by
 *  index, so an hljs patch can't quietly re-add it); returns how many went. */
export function stripJsxModes(root: Mode): number {
  let removed = 0;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const mode = node as Mode;
    if (Array.isArray(mode.contains)) {
      const kept = mode.contains.filter((c) => !isJsxMode(c));
      if (kept.length !== mode.contains.length) {
        removed += mode.contains.length - kept.length;
        mode.contains = kept;
      }
      visit(kept);
    }
    visit(mode.variants);
    visit(mode.starts);
  };
  visit(root);
  return removed;
}

// Regex follows operators or `( [ { , ; : ?`; `>` excludes `/>`, `<` excludes
// `</`, and `+`/`-` exclude doubles. Whole expression keywords exclude `.`,
// `#`, identifier/non-ASCII letters before them and `/>` after them. Regex
// never starts with `>`. Whitespace, comments and prefix `!` may intervene.
// Block bodies exclude `*/`; openers cannot follow words, `*`, quotes, `/`,
// or `[`. Line comments follow whitespace/`(`/`[`/`{`, with no earlier `//`
// within 256 characters. All checks are linear and run only at slashes.
const REGEX_START =
  /\/(?!>)(?<=(?:[=:(,{[&|?;~^%*]|(?<!\/)>|<(?!\/)|(?<!\+)\+|(?<!-)-|(?<![\w$.#]|(?!\s)[\u0080-\uFFFF]|\.\s*)(?:return|throw|case|typeof|void|delete|instanceof|in|of|new|else|do|await|yield)(?!\s*\/>)(?<=[a-z]))(?:\s|(?<![\w$*'"\x60/[])\/\*(?:[^*]|\*(?!\/))*\*\/|(?<![^\s([{])(?<!\/\/[^\n]{0,256})\/\/[^\n]*\n|!)*\/)(?=[^/\n]*\/)/;

/**
 * Splice COMMENT then regex into brace-pairing and template-substitution modes:
 * quotes or backticks in unrecognized comments can leave enclosing spans open
 * even after a later quote closes the string when ignoreIllegals is enabled.
 * Returns inserted-mode count; 0 means already spliced, target shape moved,
 * or no comment wrapper or matching regex mode found. Pins catch shape drift.
 * Rare misses: regex after `)`, `}`, a division's slash, bare `<`, or the
 * third sign of `+++`/`---`, or starting with `>`, is not recognized; `//` or
 * `/*` inside it opens a comment. Line comments glued to `:`, `,` or `=`
 * are not skipped. Division after a type argument's `>` or names
 * `of`/`await`/`yield` reads as regex.
 * JSX stays out, so JSX text holding `//` or `/*` in these contexts can still
 * open a comment.
 */
export function spliceParamsComment(root: Mode): number {
  const targets: Mode[] = [];
  let comment: Mode | undefined;
  let regexp: Mode | undefined;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const mode = node as Mode;
    const isBrace =
      mode.begin instanceof RegExp &&
      mode.begin.source === "\\{" &&
      mode.end instanceof RegExp &&
      mode.end.source === "\\}" &&
      Array.isArray(mode.contains) &&
      mode.contains[0] === "self";
    const isSubst =
      (mode.className === "subst" || mode.scope === "subst") &&
      mode.begin === "\\$\\{" &&
      mode.end === "\\}" &&
      Array.isArray(mode.contains);
    if (isBrace || isSubst) {
      targets.push(mode);
    }
    if (
      !comment &&
      (mode.className === "comment" || mode.scope === "comment") &&
      Array.isArray(mode.variants)
    ) {
      comment = mode;
    }
    if (
      !regexp &&
      (mode.className === "regexp" || mode.scope === "regexp") &&
      mode.begin instanceof RegExp &&
      mode.begin.source === /\/(?=[^/\n]*\/)/.source &&
      mode.end instanceof RegExp &&
      mode.end.source === /\/[gimuy]*/.source &&
      Array.isArray(mode.contains)
    ) {
      regexp = mode;
    }
    visit(mode.contains);
    visit(mode.variants);
    visit(mode.starts);
  };
  visit(root);
  if (!comment || !regexp) return 0;
  const expressionRegexp: Mode = {
    ...regexp,
    begin: REGEX_START,
  };
  let spliced = 0;
  for (const mode of targets) {
    if (!mode.contains) continue;
    const contains = [...mode.contains];
    let commentIndex = contains.findIndex(
      (child) =>
        typeof child === "object" &&
        (child.className === "comment" || child.scope === "comment"),
    );
    if (commentIndex === -1) {
      commentIndex = contains[0] === "self" ? 1 : 0;
      contains.splice(commentIndex, 0, comment);
      spliced++;
    }
    if (
      !contains.some(
        (child) =>
          typeof child === "object" &&
          (child.className === "regexp" || child.scope === "regexp"),
      )
    ) {
      contains.splice(commentIndex + 1, 0, expressionRegexp);
      spliced++;
    }
    mode.contains = contains;
  }
  return spliced;
}

/** Stock javascript (JSX kept) plus the params-comment splice; a failed
 *  splice falls back to stock. Aliases (js, jsx, mjs, cjs) ride the stock
 *  definition untouched. */
export const javascriptWithParamsComment: LanguageFn = (hljs) => {
  try {
    const lang = javascript(hljs);
    spliceParamsComment(lang as Mode);
    return Object.defineProperty(lang, JS_PARAMS_COMMENT, { value: true });
  } catch {
    return javascript(hljs);
  }
};

/** Whether `lang` is the comment-spliced javascript this module registers. */
export function isJsParamsComment(lang: Language | undefined): boolean {
  return !!lang && JS_PARAMS_COMMENT in lang;
}

/** Stock typescript with the comment/regex splice, minus JSX and its `tsx`
 *  alias; `tsx` belongs to {@link typescriptWithJsx}. Failure keeps stock. */
export const typescriptNoJsx: LanguageFn = (hljs) => {
  try {
    const lang = typescript(hljs);
    stripJsxModes(lang as Mode);
    spliceParamsComment(lang as Mode);
    lang.aliases = (lang.aliases ?? []).filter((a) => a !== "tsx");
    return Object.defineProperty(lang, TS_NO_JSX, { value: true });
  } catch {
    return typescript(hljs);
  }
};

/** The comment-spliced grammar under `tsx`, so ```tsx fences and a .tsx diff
 *  still on highlight.js (before its Shiki grammar loads) keep JSX.
 *  `disableAutodetect` holds only on the hljs core instance — lowlight's
 *  highlightAuto ignores it and may pick `tsx`, which keeps JSX. */
const typescriptWithJsx: LanguageFn = (hljs) => {
  try {
    const lang = typescript(hljs);
    spliceParamsComment(lang as Mode);
    return { ...lang, aliases: [], disableAutodetect: true };
  } catch {
    return { ...typescript(hljs), aliases: [], disableAutodetect: true };
  }
};

type Register = (name: string, language: LanguageFn) => void;

/** Register all three grammars through `register`. A throw keeps stock. */
function registerPatchedJsGrammars(register: Register): void {
  try {
    register("tsx", typescriptWithJsx);
    register("typescript", typescriptNoJsx);
    register("javascript", javascriptWithParamsComment);
  } catch {
    // fail soft: ids not yet registered keep their stock grammars
  }
}

/** Whether `lang` is the JSX-less grammar this module registers. */
export function isTsNoJsx(lang: Language | undefined): boolean {
  return !!lang && TS_NO_JSX in lang;
}

/**
 * Install on an engine exposing only `register` (the diff's lowlight
 * singleton), once per engine: a later custom grammar the user registers under
 * any of these ids must win, so this never re-runs over it.
 */
export function installPatchedJsGrammars(engine: { register: Register }): void {
  try {
    if (TS_NO_JSX in engine) return;
    registerPatchedJsGrammars(engine.register);
    Object.defineProperty(engine, TS_NO_JSX, { value: true });
  } catch {
    // fail soft: ids not yet registered keep their stock grammars
  }
}

/**
 * Apply to a highlight.js instance (the markdown `lib/core` singleton) whenever
 * its `typescript` or `javascript` isn't ours — loading the full build restores
 * stock grammars, so this re-checks both registered languages rather than a flag.
 */
export function ensurePatchedJsGrammars(hljs: HLJSApi): void {
  try {
    if (
      isTsNoJsx(hljs.getLanguage("typescript")) &&
      isJsParamsComment(hljs.getLanguage("javascript"))
    )
      return;
    registerPatchedJsGrammars(hljs.registerLanguage);
  } catch {
    // fail soft: ids not yet registered keep their stock grammars
  }
}
