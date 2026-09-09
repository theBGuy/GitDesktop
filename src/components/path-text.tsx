import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";

const isSep = (ch: string) => ch === "/" || ch === "\\";

/**
 * The app's one file/directory path display: middle truncation via two flex
 * spans, so the filename survives at every width with no measurement, and DOM
 * order fixes visual order (bidi can't reorder across the split). Every path
 * renders through this — hand-rolling `truncate` on one re-mints the
 * inconsistent-truncation class. The only-when-clipped tooltip lives here (same
 * remove-don't-blank contract as `clipTitle`): the outer span never overflows
 * once a child truncates, so a handler on it would be dead.
 */
export function PathText({
  path,
  line,
  className,
}: {
  path: string;
  /** Optional line number rendered as `:{line}` in the protected tail. */
  line?: number | null;
  className?: string;
}) {
  // Trailing separators belong to the tail, so `a/b/` splits at `a` | `/b/`;
  // concatenating the two spans always reproduces `path` exactly.
  let end = path.length;
  while (end > 0 && isSep(path[end - 1])) end--;
  let cut = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (isSep(path[i])) {
      cut = i;
      break;
    }
  }
  const dir = cut > 0 ? path.slice(0, cut) : "";
  const base = cut >= 0 ? path.slice(cut) : path;
  const full = line != null ? `${path}:${line}` : path;

  const onMouseEnter = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    let clipped = false;
    for (const child of el.children) {
      if (child.scrollWidth > child.clientWidth) clipped = true;
    }
    const v = full.trim();
    if (clipped && v) el.title = v;
    else el.removeAttribute("title");
  };

  return (
    <span className={cn("flex min-w-0", className)} onMouseEnter={onMouseEnter}>
      {/* min-w-0 is mandatory: a flex item's `min-width: auto` floors it at
          content width, and `truncate` silently never engages without it. */}
      {dir ? <span className="min-w-0 truncate">{dir}</span> : null}
      {/* max-w-full + truncate is the degradation path for a lone filename with
          no head to give: it end-ellipses instead of overflowing the row. */}
      <span className="max-w-full shrink-0 truncate">
        {base}
        {line != null ? `:${line}` : null}
      </span>
    </span>
  );
}
