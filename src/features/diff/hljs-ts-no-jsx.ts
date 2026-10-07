import type { HLJSApi, Language, LanguageFn, Mode } from "highlight.js";
import typescript from "highlight.js/lib/languages/typescript";

/**
 * A JSX-less `typescript` for highlight.js. The stock grammar inherits
 * javascript's JSX mode, whose `hasClosingTag` accepts `<T>` as a tag when
 * `</T` appears ANYWHERE later in the input (strings included), so one generic
 * plus a later `"</Title>"` turns the rest of a `.ts` file into unhighlighted
 * xml text. A `.ts` file can't contain JSX, so dropping the mode loses nothing.
 *
 * Must stay free of aliased and app imports:
 * scripts/ts-no-jsx-highlight.test.mjs loads it directly under Node's type
 * stripping, where `@/` paths don't resolve.
 */

// A registry symbol so the mark survives HMR re-evaluation of this module.
const TS_NO_JSX = Symbol.for("gd.hljs.tsNoJsx");

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

/** The stock typescript minus JSX, and minus its `tsx` alias (which
 *  {@link typescriptWithJsx} keeps). A failed strip falls back to stock. */
export const typescriptNoJsx: LanguageFn = (hljs) => {
  try {
    const lang = typescript(hljs);
    stripJsxModes(lang as Mode);
    lang.aliases = (lang.aliases ?? []).filter((a) => a !== "tsx");
    return Object.defineProperty(lang, TS_NO_JSX, { value: true });
  } catch {
    return typescript(hljs);
  }
};

/** The stock grammar under its own `tsx` id, so ```tsx fences and a .tsx diff
 *  still on highlight.js (before its Shiki grammar loads) keep JSX.
 *  `disableAutodetect` holds only on the hljs core instance — lowlight's
 *  highlightAuto ignores it and may pick `tsx`, which renders identically. */
export const typescriptWithJsx: LanguageFn = (hljs) => ({
  ...typescript(hljs),
  aliases: [],
  disableAutodetect: true,
});

type Register = (name: string, language: LanguageFn) => void;

/** Register both grammars through `register`. A throw leaves stock in place. */
export function registerTsNoJsx(register: Register): void {
  try {
    register("tsx", typescriptWithJsx);
    register("typescript", typescriptNoJsx);
  } catch {
    // fail soft: the stock typescript stays registered
  }
}

/** Whether `lang` is the JSX-less grammar this module registers. */
export function isTsNoJsx(lang: Language | undefined): boolean {
  return !!lang && TS_NO_JSX in lang;
}

/**
 * Install on an engine exposing only `register` (the diff's lowlight
 * singleton), once per engine: a later custom grammar the user registers under
 * either id must win, so this never re-runs over it.
 */
export function installTsNoJsx(engine: { register: Register }): void {
  try {
    if (TS_NO_JSX in engine) return;
    registerTsNoJsx(engine.register);
    Object.defineProperty(engine, TS_NO_JSX, { value: true });
  } catch {
    // fail soft: the stock typescript stays registered
  }
}

/**
 * Apply to a highlight.js instance (the markdown `lib/core` singleton) whenever
 * its `typescript` isn't ours — loading the full build re-registers the stock
 * grammar, so this re-checks the registered language rather than a flag.
 */
export function ensureTsNoJsx(hljs: HLJSApi): void {
  try {
    if (isTsNoJsx(hljs.getLanguage("typescript"))) return;
    registerTsNoJsx(hljs.registerLanguage);
  } catch {
    // fail soft: the stock typescript stays registered
  }
}
