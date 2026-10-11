import hljs from "highlight.js/lib/common";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import "./code-highlight.css";

/**
 * One code line, syntax-highlighted when highlight.js recognizes `language`,
 * otherwise plain text. The single-line sibling of `HighlightedCode`.
 */
export function HighlightedLine({
  content,
  language,
  className,
}: {
  content: string;
  language: string | null | undefined;
  className?: string;
}) {
  // A stable wrapper object is the ≤19.2 backstop: those react-doms re-apply
  // dangerouslySetInnerHTML on wrapper identity (19.3+ compares the string).
  const markup = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    const html = hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value;
    return { __html: html || " " };
  }, [content, language]);
  const base = "px-2 whitespace-pre-wrap";
  if (markup === null) {
    return <span className={cn(base, className)}>{content || " "}</span>;
  }
  return (
    // highlight.js output of local file text, themed + scoped to .gd-code.
    <span
      className={cn("gd-code", base, className)}
      dangerouslySetInnerHTML={markup}
    />
  );
}
