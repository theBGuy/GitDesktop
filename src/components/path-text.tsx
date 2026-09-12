import { type MouseEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const isSep = (ch: string) => ch === "/" || ch === "\\";

/**
 * The app's one file/directory path display: middle truncation via two flex
 * spans, so the filename survives at every width with no measurement, and DOM
 * order fixes visual order (bidi can't reorder across the split). Every path
 * renders through this — hand-rolling `truncate` on one re-mints the
 * inconsistent-truncation class. The only-when-clipped tooltip lives here (same
 * remove-don't-blank contract as `clipTitle`): the outer span never overflows
 * once a child truncates, so a handler on it would be dead. The tooltip keeps
 * the path's own leading/trailing whitespace — those are identity characters
 * in a git path.
 */
export function PathText({
  path,
  line,
  title,
  className,
}: {
  path: string;
  /** Optional line number rendered as `:{line}` in the protected tail. */
  line?: number | null;
  /** Tooltip value when clipped, for a rendered path that is a relativized
   *  form of a longer canonical one (e.g. a transcript target) — the richer
   *  string wins where the truncation already hides text. */
  title?: string;
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
  const dir = cut >= 0 ? path.slice(0, cut) : "";
  const base = cut >= 0 ? path.slice(cut) : path;
  const full = line != null ? `${path}:${line}` : path;
  const tip = title ?? full;

  const ref = useRef<HTMLSpanElement>(null);
  // The title is set imperatively, so React never clears it: a reused element
  // (navigated header, windowed row) would keep the PREVIOUS path's tooltip
  // until the next hover. Drop it the moment it no longer matches the content.
  useEffect(() => {
    const el = ref.current;
    if (el && el.title && el.title !== tip) el.removeAttribute("title");
  }, [tip]);

  const onMouseEnter = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    let clipped = false;
    for (const child of el.children) {
      if (child.scrollWidth > child.clientWidth) clipped = true;
    }
    if (clipped && tip.trim()) el.title = tip;
    else el.removeAttribute("title");
  };

  return (
    // min-w-0 here is the load-bearing one: without it the outer span floors
    // at content width in ITS flex row and the children never shrink. (The
    // dir span's copy is belt-and-braces — `truncate`'s overflow:hidden
    // already zeroes a flex item's automatic minimum size.)
    <span
      ref={ref}
      className={cn("flex min-w-0", className)}
      onMouseEnter={onMouseEnter}
    >
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
