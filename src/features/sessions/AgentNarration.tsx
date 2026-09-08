import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { hljsUpgradeStore } from "@/components/markdown/markdown-hljs";
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

// The marks a qualifying span carries. Listed once because the walk both adds
// and removes them: an unmark that misses one leaves a span that still looks or
// reads as a link.
const MARK_ATTRS = ["data-gd-file", "role", "tabindex", "aria-label"];
const MARK_CLASSES = [
  "cursor-pointer",
  "underline",
  "decoration-dotted",
  "underline-offset-2",
  "hover:text-foreground",
  "focus-visible:outline-1",
  "focus-visible:outline-ring",
];

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
  // The shared renderer re-injects its whole innerHTML when the lazy
  // highlight.js upgrade bumps this snapshot, discarding every mark below while
  // `text` stays value-identical.
  const hljsVersion = useSyncExternalStore(
    hljsUpgradeStore.subscribe,
    hljsUpgradeStore.getSnapshot,
    hljsUpgradeStore.getServerSnapshot,
  );

  // After each render, turn inline-code spans that look like file paths into
  // real, keyboard-operable links (button role + tab stop) — using a layout
  // effect so the styling lands before paint (no flicker while streaming) and
  // without modifying the shared Markdown renderer. Marking is two-directional
  // for symmetry: an identical re-parse preserves these nodes, so a future
  // non-DOM input to the decision could otherwise strand marks.
  // Neither dep is read inside the effect — `text` and `hljsVersion` are
  // deliberate re-walk triggers for the DOM they rebuild.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text and hljsVersion are intentional re-walk triggers
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll("code")) {
      // A fenced block isn't a file ref, and a code span inside a link label
      // belongs to the link — marking it would double-dispatch on activation.
      // The `||` short-circuits past the text read for both.
      if (el.closest("pre, a") || !isFilePath(el.textContent ?? "")) {
        if (el.hasAttribute("data-gd-file")) {
          for (const attr of MARK_ATTRS) el.removeAttribute(attr);
          el.classList.remove(...MARK_CLASSES);
        }
        continue;
      }
      const path = filePathOf(el.textContent ?? "");
      el.setAttribute("data-gd-file", path);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", `Open ${path}`);
      el.classList.add(...MARK_CLASSES);
    }
  }, [text, hljsVersion]);

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

  // A middle click rides `auxclick` and never fires `click`, so the dispatch has
  // to be reachable from here too or the third button is dead on a marked span.
  const onAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    if (activate(e.target)) e.preventDefault();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (activate(e.target)) e.preventDefault();
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
    >
      <Markdown className="px-0.5">{text}</Markdown>
    </div>
  );
}
