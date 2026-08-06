import hljs from "highlight.js/lib/common";
import { cn } from "@/lib/utils";
import "./code-highlight.css";
import { diffLang } from "./diff-lang";

/**
 * A read-only, syntax-highlighted view of a whole file's text. Highlights the
 * full content in one pass (so multi-line strings/comments keep their context,
 * unlike per-line highlighting) via highlight.js. Falls back to plain,
 * still-readable text for languages highlight.js doesn't recognize.
 */
export function HighlightedCode({
  path,
  content,
  className,
}: {
  path: string;
  content: string;
  className?: string;
}) {
  const lang = diffLang(path);
  const html =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
      : null;
  const base =
    "p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-break-word";
  if (html === null) {
    return <pre className={cn(base, className)}>{content || " "}</pre>;
  }
  return (
    // highlight.js output of a local file's text, themed + scoped to .gd-code.
    <pre
      className={cn("gd-code", base, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
