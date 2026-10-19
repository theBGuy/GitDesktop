import type { HLJSApi, Language, LanguageFn, Mode } from "highlight.js";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";

/**
 * A JSX-less `typescript` for highlight.js. The stock grammar inherits
 * javascript's JSX mode, whose `hasClosingTag` accepts `<T>` as a tag when
 * `</T` appears ANYWHERE later in the input (strings included), so one generic
 * plus a later `"</Title>"` turns the rest of a `.ts` file into unhighlighted
 * xml text. A `.ts` file can't contain JSX, so dropping the mode loses nothing.
 * TypeScript, tsx, and javascript also splice COMMENT into their shared params
 * brace mode so apostrophes in comments leave subsequent code tokenized.
 *
 * Must stay free of aliased and app imports:
 * scripts/ts-no-jsx-highlight.test.mjs loads it directly under Node's type
 * stripping, where `@/` paths don't resolve.
 */

// A registry symbol so the mark survives HMR re-evaluation of this module.
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

/**
 * Splice the grammar's COMMENT mode into each `{`/`}` pairing mode that lacks
 * one: params and template substitutions share that mode, and without COMMENT
 * a comment's apostrophe there opens a string that ignoreIllegals runs to EOF.
 * Returns the count spliced (0 when the shape moved; the pin test catches that).
 * Regex and JSX modes stay out, as in the grammar's own parens mode, so a regex
 * literal or JSX text holding `//` or `/*` in these braces reads as a comment.
 */
export function spliceParamsComment(root: Mode): number {
  const braces: Mode[] = [];
  let comment: Mode | undefined;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const mode = node as Mode;
    if (
      mode.begin instanceof RegExp &&
      mode.begin.source === "\\{" &&
      mode.end instanceof RegExp &&
      mode.end.source === "\\}" &&
      Array.isArray(mode.contains) &&
      mode.contains[0] === "self"
    ) {
      braces.push(mode);
    }
    if (
      !comment &&
      (mode.className === "comment" || mode.scope === "comment") &&
      Array.isArray(mode.variants)
    ) {
      comment = mode;
    }
    visit(mode.contains);
    visit(mode.variants);
    visit(mode.starts);
  };
  visit(root);
  if (!comment) return 0;
  let spliced = 0;
  for (const mode of braces) {
    const contains = mode.contains;
    if (
      !contains ||
      contains.some(
        (child) =>
          typeof child === "object" &&
          (child.className === "comment" || child.scope === "comment"),
      )
    ) {
      continue;
    }
    mode.contains = [contains[0], comment, ...contains.slice(1)];
    spliced++;
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

/** The stock typescript minus JSX and its `tsx` alias, plus the params-comment
 *  splice; that id belongs to {@link typescriptWithJsx}. Failure keeps stock. */
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
function registerTsNoJsx(register: Register): void {
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
 * any id must win, so this never re-runs over it.
 */
export function installTsNoJsx(engine: { register: Register }): void {
  try {
    if (TS_NO_JSX in engine) return;
    registerTsNoJsx(engine.register);
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
export function ensureTsNoJsx(hljs: HLJSApi): void {
  try {
    if (
      isTsNoJsx(hljs.getLanguage("typescript")) &&
      isJsParamsComment(hljs.getLanguage("javascript"))
    )
      return;
    registerTsNoJsx(hljs.registerLanguage);
  } catch {
    // fail soft: ids not yet registered keep their stock grammars
  }
}
