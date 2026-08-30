/**
 * Map a file path to a highlight.js language name. Returning undefined means
 * "don't highlight" — the diff renders as plain text. We never let the
 * highlighter auto-detect a language: on unknown content it tries every
 * grammar, which is slow and frequently wrong.
 */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  // tsx/jsx → Shiki (highlight.js's typescript/javascript don't highlight JSX).
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  php: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "dos",
  cmd: "dos",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  // Shiki-only languages — highlight.js ships no grammar for these, so they go
  // through the Shiki engine (see features/diff/shiki-highlighter.ts) instead
  // of the approximate fallbacks (toml/tf as ini, svelte as xml) used before.
  astro: "astro",
  svelte: "svelte",
  mdx: "mdx",
  prisma: "prisma",
  sol: "solidity",
  wgsl: "wgsl",
  gd: "gdscript",
  jsonnet: "jsonnet",
  libsonnet: "jsonnet",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  scala: "scala",
  pl: "perl",
  pm: "perl",
  diff: "diff",
  patch: "diff",
  proto: "protobuf",
  cmake: "cmake",
  gradle: "gradle",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  zig: "zig",
};

// Files identified by their full name rather than an extension.
const FILE_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
};

export function diffLang(
  filePath: string,
  /** User extension→language overrides (no dot, lowercase keys). Win over
   *  every built-in, so a user can remap a known extension or add a new one. */
  userMap?: Record<string, string>,
): string | undefined {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const name = filePath.slice(slash + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  // dot <= 0 also rejects dotfiles like ".gitignore" — no extension to map.
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ext && userMap?.[ext]) return userMap[ext];
  const byName = FILE_LANG[name];
  if (byName) return byName;
  return ext ? EXT_LANG[ext] : undefined;
}

/** The extension (no dot, lowercase) of a path, or "" when there's none. */
export function fileExt(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const name = filePath.slice(slash + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}
