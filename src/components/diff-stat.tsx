import { cn } from "@/lib/utils";

/**
 * The app's one `+added -deleted` line-count span. The `+`/`-` glyphs carry the
 * meaning on their own, so the success/destructive colors stay decorative
 * (WCAG AA: never color alone). Callers own size and spacing via `className`;
 * this component has no opinion beyond `shrink-0` and tabular digits. The
 * glyphs are `aria-hidden` behind an `sr-only` name span, which is absolutely
 * positioned and so never becomes a flex item in a caller's layout.
 */
export function DiffStat({
  added,
  deleted,
  isBinary,
  format = String,
  className,
}: {
  added: number;
  deleted: number;
  isBinary?: boolean;
  /** Number formatter for sites that abbreviate (Insights uses `fmt`). */
  format?: (n: number) => string;
  className?: string;
}) {
  if (isBinary) {
    return (
      <span className={cn("shrink-0 text-muted-foreground", className)}>
        <span aria-hidden>bin</span>
        <span className="sr-only">Binary file</span>
      </span>
    );
  }
  return (
    <span className={cn("shrink-0 tabular-nums", className)}>
      <span aria-hidden className="text-success">
        +{format(added)}
      </span>
      {/* Separator for inline callers (a canonical text space). Flex callers
          bring their own gap and never see it: a whitespace-only anonymous flex
          item is not rendered (CSS Flexbox §4). */}{" "}
      <span aria-hidden className="text-destructive">
        -{format(deleted)}
      </span>
      {/* Raw counts, never `format`: an abbreviating caller (Insights) still
          owes assistive tech the exact numbers. */}
      <span className="sr-only">
        {added} {added === 1 ? "line" : "lines"} added, {deleted}{" "}
        {deleted === 1 ? "line" : "lines"} deleted
      </span>
    </span>
  );
}
