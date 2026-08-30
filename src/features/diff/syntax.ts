import { highlighter } from "@git-diff-view/react";
import type { CustomLanguage } from "@/lib/settings/api";
import { builtinShikiLangs } from "./shiki-highlighter";

/**
 * Diff syntax-highlighting support. The diff renderer (@git-diff-view) uses a
 * shared lowlight/highlight.js engine registered with every bundled language;
 * we read its language list for pickers and register the user's custom grammars
 * on the same engine so `fileLang` lookups resolve them.
 */

// Minimal highlight.js grammar shape. Built as plain data so we don't take a
// type dependency on highlight.js (a transitive dep of the diff renderer).
type GrammarMode = {
  scope?: string;
  begin?: string;
  end?: string;
  relevance?: number;
  contains?: GrammarMode[];
};
type Grammar = {
  name?: string;
  case_insensitive?: boolean;
  keywords?: string;
  contains?: GrammarMode[];
};

let cachedLangs: string[] | null = null;

/**
 * Every language available for highlighting, sorted: the highlight.js languages
 * registered in the diff engine plus the built-in Shiki languages (astro &c.)
 * that highlight.js can't render.
 */
export function supportedLanguages(): string[] {
  if (cachedLangs) return cachedLangs;
  try {
    cachedLangs = [
      ...new Set([
        ...highlighter.getHighlighterEngine().listLanguages(),
        ...builtinShikiLangs(),
      ]),
    ].sort();
  } catch {
    cachedLangs = [...builtinShikiLangs()].sort();
  }
  return cachedLangs;
}

// Friendly names for the languages people reach for most; everything else
// falls back to its raw highlight.js id.
const LABELS: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  json: "JSON",
  xml: "HTML / XML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  python: "Python",
  rust: "Rust",
  go: "Go",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  bash: "Shell / Bash",
  powershell: "PowerShell",
  dos: "Batch",
  yaml: "YAML",
  ini: "INI / TOML",
  markdown: "Markdown",
  mdx: "MDX",
  sql: "SQL",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  lua: "Lua",
  dart: "Dart",
  elixir: "Elixir",
  erlang: "Erlang",
  haskell: "Haskell",
  scala: "Scala",
  graphql: "GraphQL",
  protobuf: "Protocol Buffers",
  vue: "Vue",
  astro: "Astro",
  svelte: "Svelte",
  toml: "TOML",
  terraform: "Terraform",
  hcl: "HCL",
  prisma: "Prisma",
  solidity: "Solidity",
  zig: "Zig",
  wgsl: "WGSL",
  gdscript: "GDScript",
  jsonnet: "Jsonnet",
  plaintext: "Plain text",
};

export function languageLabel(name: string): string {
  return LABELS[name] ?? name;
}

// Surfaced first in pickers; the long tail follows alphabetically.
const COMMON = [
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "json",
  "xml",
  "css",
  "scss",
  "python",
  "rust",
  "go",
  "ruby",
  "java",
  "csharp",
  "cpp",
  "c",
  "php",
  "bash",
  "powershell",
  "yaml",
  "toml",
  "ini",
  "markdown",
  "sql",
  "astro",
  "svelte",
  "plaintext",
];

/** The common languages that are actually registered, in curated order. */
export function commonLanguages(): string[] {
  const supported = new Set(supportedLanguages());
  return COMMON.filter((l) => supported.has(l));
}

const RX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(RX_SPECIAL, "\\$&");
}

function buildGrammar(lang: CustomLanguage): () => Grammar {
  const keywords = lang.keywords
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
  return () => {
    const contains: GrammarMode[] = [];
    if (lang.lineComment) {
      contains.push({
        scope: "comment",
        begin: escapeRegex(lang.lineComment),
        end: "$",
      });
    }
    if (lang.blockCommentStart && lang.blockCommentEnd) {
      contains.push({
        scope: "comment",
        begin: escapeRegex(lang.blockCommentStart),
        end: escapeRegex(lang.blockCommentEnd),
      });
    }
    for (const quote of new Set(lang.stringDelimiters.split(""))) {
      if (!quote.trim()) continue;
      contains.push({
        scope: "string",
        begin: escapeRegex(quote),
        end: escapeRegex(quote),
        contains: [{ begin: "\\\\." }], // allow escaped chars inside strings
      });
    }
    contains.push({
      scope: "number",
      begin: "\\b\\d+(?:\\.\\d+)?\\b",
      relevance: 0,
    });
    return {
      name: lang.name || lang.id,
      case_insensitive: lang.caseInsensitive,
      keywords: keywords || undefined,
      contains,
    };
  };
}

let registeredSig = "";

/**
 * Register (or refresh) the user's custom grammars on the shared diff
 * highlighter. Idempotent — a no-op while the set is unchanged. A bad grammar
 * is isolated so it can't break the others (that diff falls back to plain).
 */
export function ensureCustomLanguages(langs: readonly CustomLanguage[]): void {
  const sig = JSON.stringify(langs);
  if (sig === registeredSig) return;
  registeredSig = sig;
  let register: (name: string, grammar: unknown) => void;
  try {
    // The lowlight register expects a highlight.js LanguageFn; our plain-data
    // factory is structurally compatible, so cast past the precise type.
    register = highlighter.getHighlighterEngine().register as (
      name: string,
      grammar: unknown,
    ) => void;
  } catch {
    return;
  }
  for (const lang of langs) {
    // Languages with a full TextMate grammar are rendered by Shiki, not here.
    if (!lang.id || lang.tmGrammar) continue;
    try {
      register(lang.id, buildGrammar(lang));
    } catch {
      // skip a malformed grammar; keep registering the rest
    }
  }
}

/** Slugify a name into a safe custom-language id (lowercase, hyphenated). */
export function toLangId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
