import { useLayoutEffect, useRef } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { useOpenFile } from "./useOpenFile";

// Extensions we treat as file references when they appear in an inline-code
// span (a span with a slash is always a path; a bare `name.ext` is only a file
// if its extension is one we recognize, so method calls like `arr.map` or prose
// like `e.g` in code aren't mistaken for files).
const KNOWN_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "rs",
  "go",
  "py",
  "rb",
  "php",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "vue",
  "svelte",
  "astro",
  "md",
  "mdx",
  "txt",
  "toml",
  "yaml",
  "yml",
  "ini",
  "cfg",
  "conf",
  "env",
  "lock",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "gql",
  "proto",
  "gradle",
  "bat",
  "ps1",
  "lua",
  "dart",
  "ex",
  "exs",
  "clj",
  "scala",
  "pl",
]);

/** Strip a trailing `:line[:col]` or `#Lx` locator before resolving the path. */
function filePathOf(raw: string): string {
  return raw.trim().replace(/[:#].*$/, "");
}

function isFilePath(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 200 || /\s/.test(t) || t.includes("://")) return false;
  const core = filePathOf(t);
  if (!core || core.startsWith("-")) return false;
  if (core.includes("/")) return true;
  const dot = core.lastIndexOf(".");
  if (dot <= 0) return false;
  return KNOWN_EXT.has(core.slice(dot + 1).toLowerCase());
}

/**
 * Renders the agent's streamed Markdown narration, then post-processes it so
 * inline-code spans that look like file paths become clickable links that open
 * the file (resolved against the session's worktree) in the user's editor —
 * without modifying the shared Markdown renderer.
 */
export function AgentNarration({
  text,
  baseDir,
}: {
  text: string;
  baseDir: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const openFile = useOpenFile();

  // After each render, turn inline-code spans that look like file paths into
  // real, keyboard-operable links (button role + tab stop) — using a layout
  // effect so the styling lands before paint (no flicker while streaming) and
  // without modifying the shared Markdown renderer. Re-runs whenever the text
  // changes; Markdown replaces its innerHTML on each delta, so spans are fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-mark on each streamed update
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll("code")) {
      if (el.closest("pre")) continue; // fenced code blocks aren't file refs
      const raw = el.textContent ?? "";
      if (!isFilePath(raw)) continue;
      const path = filePathOf(raw);
      el.setAttribute("data-gd-file", path);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", `Open ${path}`);
      el.classList.add(
        "cursor-pointer",
        "underline",
        "decoration-dotted",
        "underline-offset-2",
        "hover:text-foreground",
        "focus-visible:outline-1",
        "focus-visible:outline-ring",
      );
    }
  }, [text]);

  const activate = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-gd-file]",
    );
    const rel = el?.getAttribute("data-gd-file");
    if (rel) openFile(baseDir, rel);
    return Boolean(rel);
  };

  const onClick = (e: React.MouseEvent) => {
    if (activate(e.target)) e.preventDefault();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (activate(e.target)) e.preventDefault();
  };

  return (
    <div ref={ref} onClick={onClick} onKeyDown={onKeyDown}>
      <Markdown className="px-0.5">{text}</Markdown>
    </div>
  );
}
