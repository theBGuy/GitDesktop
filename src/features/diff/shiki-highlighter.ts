import {
  type DiffAST,
  type DiffFileHighlighter,
  processAST,
} from "@git-diff-view/core";
import { createHighlighterCoreSync, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
// `json` stays a static import: it's small, and it backs the synchronous
// `highlightJson` (webhook payload viewer) which can't await a lazy load
// without regressing to plain text on first paint. It's kept out of the lazy
// `BUILTIN_LANGS` map so it never re-routes `.json` diffs (those stay
// highlight.js). The heavy grammars (jsx/tsx &c.) load on demand — see below.
import jsonGrammar from "@shikijs/langs/json";
import type { LanguageRegistration } from "@shikijs/types";
import type { CustomLanguage } from "@/lib/settings/api";
import { gapIsolatedAst } from "./gap-isolation";
import { gdDiff } from "./shiki-theme";

/**
 * A TextMate highlighter for the diff, backed by Shiki with the pure-JS regex
 * engine (no WASM). Used for custom languages that carry a real
 * `.tmLanguage.json` grammar and for built-in Shiki languages highlight.js
 * lacks, so they render exactly like VSCode — far beyond what the minimal
 * highlight.js grammar can express. Everything is synchronous so it fits
 * @git-diff-view's sync `getAST`.
 */

let core: HighlighterCore | null = null;
const loaded = new Set<string>();

function getCore(): HighlighterCore {
  if (!core) {
    core = createHighlighterCoreSync({
      themes: [gdDiff],
      langs: [],
      // forgiving: skip Oniguruma patterns the JS engine can't convert rather
      // than throwing, so a quirky grammar still highlights the rest.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return core;
}

/** Register Shiki grammars for any custom languages that carry one. Idempotent. */
export function ensureShikiGrammars(langs: readonly CustomLanguage[]): void {
  for (const lang of langs) {
    if (!lang.tmGrammar || !lang.id || loaded.has(lang.id)) continue;
    try {
      // tmGrammar is parsed-from-disk JSON (an imported `.tmLanguage.json`), so
      // it's only loosely typed; assert it to the grammar shape Shiki expects.
      const grammar: LanguageRegistration = {
        ...lang.tmGrammar,
        name: lang.id,
      } as LanguageRegistration;
      getCore().loadLanguageSync(grammar);
      loaded.add(lang.id);
    } catch {
      // unsupported grammar — leave it unloaded; the diff falls back to plain
    }
  }
}

/** Whether a language id has a Shiki grammar loaded and ready. */
export function isShikiLang(id: string): boolean {
  return loaded.has(id);
}

/**
 * Languages Shiki bundles that highlight.js lacks (or renders poorly), offered
 * as built-in picker options. Each value is a dynamic loader that imports the
 * full grammar bundle from `@shikijs/langs` — the language plus every grammar it
 * embeds (astro/vue frontmatter = TS, <style> = CSS, expressions = TSX). The
 * grammars are imported lazily (~557KB, jsx+tsx dominating) so they stay off the
 * startup chunk and load only when a diff of that language is first opened. The
 * key matches the bundle's own grammar name (Shiki's filename convention), which
 * is what gets registered and what we pass to `codeToTokensBase`.
 */
const BUILTIN_LANGS: Record<
  string,
  () => Promise<{ default: LanguageRegistration[] }>
> = {
  astro: () => import("@shikijs/langs/astro"),
  gdscript: () => import("@shikijs/langs/gdscript"),
  hcl: () => import("@shikijs/langs/hcl"),
  jsonnet: () => import("@shikijs/langs/jsonnet"),
  // tsx/jsx render via Shiki because highlight.js's typescript/javascript
  // grammars don't tokenize JSX (the markup stayed plain).
  jsx: () => import("@shikijs/langs/jsx"),
  prisma: () => import("@shikijs/langs/prisma"),
  // Rust renders via Shiki because highlight.js's flat tokenizer can mis-scope
  // a lifetime/char-literal sequence and swallow the rest of the file as one
  // token — leaving everything past that point unhighlighted. TextMate grammars
  // are stateful and always emit one token line per source line, so coverage is
  // complete regardless of tricky/mid-edit content.
  rust: () => import("@shikijs/langs/rust"),
  solidity: () => import("@shikijs/langs/solidity"),
  svelte: () => import("@shikijs/langs/svelte"),
  terraform: () => import("@shikijs/langs/terraform"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  vue: () => import("@shikijs/langs/vue"),
  wgsl: () => import("@shikijs/langs/wgsl"),
  zig: () => import("@shikijs/langs/zig"),
};

/** Ids of the built-in Shiki languages, for pickers / language lists. */
export function builtinShikiLangs(): readonly string[] {
  return Object.keys(BUILTIN_LANGS);
}

/** Whether `id` is a built-in Shiki language (loaded or not). Synchronous. */
export function isBuiltinShikiLang(id: string): boolean {
  return id in BUILTIN_LANGS;
}

// In-flight loads, so concurrent diffs of the same not-yet-loaded language
// share one import + register rather than racing to load it twice.
const loading = new Map<string, Promise<boolean>>();

/**
 * Load a built-in Shiki language (and its embedded grammars) on demand.
 * Resolves true once it's loaded and ready, false for an unknown id or a load
 * failure. Idempotent, and concurrent calls for the same id share one load.
 */
export async function ensureBuiltinShikiLang(id: string): Promise<boolean> {
  if (loaded.has(id)) return true;
  const loader = BUILTIN_LANGS[id];
  if (!loader) return false;
  const inflight = loading.get(id);
  if (inflight) return inflight;
  const load = (async () => {
    try {
      const bundle = (await loader()).default;
      // The bundle is an array of grammars (the language + its embeds);
      // loadLanguageSync accepts the array directly. Duplicate embeds across
      // languages just overwrite — harmless.
      getCore().loadLanguageSync(bundle);
      loaded.add(id);
      return true;
    } catch {
      return false;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, load);
  return load;
}

export interface CodeToken {
  content: string;
  color: string;
}

let jsonLoaded = false;

/**
 * Tokenizes a JSON snippet for inline-styled display (webhook delivery
 * payloads). Reuses the diff's Shiki core + theme, but loads `json` outside
 * `BUILTIN_LANGS` so it never re-routes `.json` diffs (those stay highlight.js).
 * Returns lines of `{content, color}` tokens, or null if it can't tokenize.
 * Each `color` is a `var(--gd-syn-*)` reference, so the caller's inline style
 * follows the app theme without re-tokenizing.
 */
export function highlightJson(code: string): CodeToken[][] | null {
  if (!jsonLoaded) {
    try {
      getCore().loadLanguageSync(jsonGrammar);
      jsonLoaded = true;
    } catch {
      return null;
    }
  }
  try {
    return getCore()
      .codeToTokensBase(code, { lang: "json", theme: gdDiff.name })
      .map((line) =>
        line.map((t) => ({ content: t.content, color: t.color ?? "" })),
      );
  } catch {
    return null;
  }
}

// Shiki FontStyle bitmask: Italic = 1, Bold = 2, Underline = 4.
function styleFor(color: string | undefined, fontStyle: number | undefined) {
  const parts: string[] = [];
  if (color) parts.push(`color:${color}`);
  if (fontStyle) {
    if (fontStyle & 1) parts.push("font-style:italic");
    if (fontStyle & 2) parts.push("font-weight:bold");
    if (fontStyle & 4) parts.push("text-decoration:underline");
  }
  return parts.join(";");
}

// An empty tree for inputs we can't tokenize; the renderer treats it as "no
// highlighting" and falls back to plain text, same as a missing AST.
const EMPTY_AST: DiffAST = { type: "root", children: [] };

// Flat hast (the same shape highlight.js produces): token spans separated by
// "\n" text nodes. The renderer applies each span's `properties.style` directly.
// The `theme` arg @git-diff-view threads to `getAST` is ignored: token colors
// are CSS variables, so one tokenization serves both app themes.
function buildHast(raw: string, lang: string): DiffAST {
  const lines = getCore().codeToTokensBase(raw, {
    lang,
    theme: gdDiff.name,
  });
  const children: DiffAST["children"] = [];
  lines.forEach((line, i) => {
    for (const token of line) {
      children.push({
        type: "element",
        tagName: "span",
        properties: { style: styleFor(token.color, token.fontStyle) },
        children: [{ type: "text", value: token.content }],
      });
    }
    if (i < lines.length - 1) children.push({ type: "text", value: "\n" });
  });
  return { type: "root", children };
}

/**
 * Line cap on the RECONSTRUCTED file, deciding whether a small edit deep in a
 * big file gets highlighted at all (not the diff's own size). Placeholder-
 * reconstructed lines tokenize cheaply (measured 61ms at 12K lines). The ONE
 * shared cap for every highlighter the diff uses — the Shiki object below, the
 * highlight.js singleton pin, and the worker-AST precomputed highlighter (both
 * in DiffSurface.tsx) — so they can't silently diverge.
 */
export const SYNTAX_LINE_CAP = 15_000;

/**
 * A @git-diff-view DiffFileHighlighter that tokenizes with Shiki and emits
 * style-based spans (the renderer applies `properties.style` directly). AST
 * post-processing is reused from the default highlighter's exported `processAST`.
 */
export function shikiDiffHighlighter(): DiffFileHighlighter {
  return {
    name: "shiki",
    type: "style",
    maxLineToIgnoreSyntax: SYNTAX_LINE_CAP,
    setMaxLineToIgnoreSyntax: () => undefined,
    ignoreSyntaxHighlightList: [],
    setIgnoreSyntaxHighlightList: () => undefined,
    getAST: (raw, _fileName, lang) => {
      if (!lang || !loaded.has(lang)) return EMPTY_AST;
      try {
        return gapIsolatedAst(raw, (segment) => buildHast(segment, lang));
      } catch {
        return EMPTY_AST;
      }
    },
    processAST,
    hasRegisteredCurrentLang: (lang) => loaded.has(lang),
  };
}
