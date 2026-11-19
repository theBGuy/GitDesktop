import { type MouseEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const isSep = (ch: string) => ch === "/" || ch === "\\";

/** JetBrains Mono's measured advance (exactly 0.6em at 10-16 px; CSS `1ch` is
 *  shorter). Every PathText renders in that font today; a font change, or a new
 *  site under a proportional font, must re-measure it. */
const GLYPH_ADVANCE_EM = 0.6;
/** Covers the layout engine flooring the rounded width to 1/64 px. */
const ROUND_SLACK_PX = 0.05;

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
/** A leaf that `nowrap` collapses (a space run, a line-end space) renders fewer
 *  glyphs than its length. PRINTABLE_ASCII admits no white space but U+0020,
 *  and the leaf always opens with a separator, so no leading arm is needed. */
const COLLAPSIBLE_SPACE = / {2}| $/;

/** Caps the head at the space beside an `n`-glyph leaf, in whole glyphs, so
 *  the clipped head's leftover sits after the leaf rather than before it. */
const headMaxWidth = (n: number) =>
  `max(calc(round(down, calc(100% - ${n} * ${GLYPH_ADVANCE_EM}em), ${GLYPH_ADVANCE_EM}em) + ${ROUND_SLACK_PX}px), ${2 * GLYPH_ADVANCE_EM}em)`;

/**
 * The app's one file/directory path display: middle truncation via two flex
 * spans, so the filename survives at every width with no measurement, and DOM
 * order fixes visual order (bidi can't reorder across the split). Every path
 * renders through this — hand-rolling `truncate` on one re-mints the
 * inconsistent-truncation class. The only-when-clipped tooltip lives here (same
 * remove-don't-blank contract as `clipTitle`), on the outer span, which never
 * overflows itself; it keeps the path's own leading/trailing whitespace, which
 * is identity in a git path. The accessible name rides an sr-only full copy
 * behind `aria-hidden` visual spans, since flex items would join with a space.
 * The head snaps to whole 0.6em glyphs, so it is gated to printable ASCII; an
 * engine without `round()` drops the declaration and keeps the plain layout.
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
  // UTF-16 length is the glyph count only for printable ASCII, the whole path
  // included: a wider head glyph would let the rounding cut a head that fits.
  // Only the leaf's spaces matter: the head's own collapse changes its natural
  // width, not the room beside the leaf the formula measures.
  const leaf = full.slice(dir.length);
  const snap =
    dir !== "" && PRINTABLE_ASCII.test(full) && !COLLAPSIBLE_SPACE.test(leaf);

  const ref = useRef<HTMLSpanElement>(null);
  const srRef = useRef<HTMLSpanElement>(null);
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
      // The sr-only copy is a 1px overflow-hidden box: it always reads clipped.
      if (child === srRef.current) continue;
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
      {dir ? (
        <span
          aria-hidden="true"
          className="min-w-0 truncate"
          style={snap ? { maxWidth: headMaxWidth(leaf.length) } : undefined}
        >
          {dir}
        </span>
      ) : null}
      {/* max-w-full + truncate is the degradation path for a lone filename with
          no head to give: it end-ellipses instead of overflowing the row. */}
      <span
        aria-hidden={dir ? "true" : undefined}
        className="max-w-full shrink-0 truncate"
      >
        {base}
        {line != null ? `:${line}` : null}
      </span>
      {dir ? (
        <span ref={srRef} className="sr-only select-none">
          {full}
        </span>
      ) : null}
    </span>
  );
}
