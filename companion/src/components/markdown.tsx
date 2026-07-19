import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";

// Renders GitHub-flavored Markdown (PR descriptions, comments, review bodies, and
// the agent watch's final answer). Modeled on the desktop's
// `src/components/ui/markdown.tsx` — marked (GFM) → DOMPurify.sanitize →
// dangerouslySetInnerHTML — but deliberately leaner for the phone bundle:
//   • NO highlight.js — fenced code renders as marked's default escaped
//     `<pre><code>`, styled by `.markdown-body pre` as a mono block that scrolls
//     inside its OWN container (the page never scrolls sideways).
//   • NO @tauri-apps/plugin-opener — this is a browser, so links just open in a new
//     tab (`target="_blank"` + `rel="noopener noreferrer"`, set by the hook below so
//     a tap never navigates the companion page away).
// DOMPurify keeps its strict defaults: GitHub comments embed real HTML
// (details/summary, tables, <img> badges) which are allowed, while scripts and
// inline event handlers are stripped. (The page CSP `img-src 'self' data:` blocks
// cross-origin badge images — expected; nothing here weakens it.)

const md = new Marked({ gfm: true });

// Force external links to open in a new tab without leaking the opener. Registered
// once at module load (DOMPurify hooks are global to the singleton). Runs after
// sanitize, so it only ever sees anchors DOMPurify already deemed safe.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render a Markdown string as sanitized, formatted HTML. Styling lives in the
 *  `.markdown-body` block in `index.css` (scoped, token-based). */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const html = useMemo(() => {
    const raw = md.parse(children, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [children]);

  return (
    <div
      className={className ? `markdown-body ${className}` : "markdown-body"}
      // Sanitized above — DOMPurify strips scripts and event handlers.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
