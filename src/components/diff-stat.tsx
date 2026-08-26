import { cn } from "@/lib/utils";

/**
 * The app's one `+added -deleted` line-count span. The `+`/`-` glyphs carry the
 * meaning on their own, so the success/destructive colors stay decorative
 * (WCAG AA: never color alone). Callers own size and spacing via `className`;
 * this component has no opinion beyond `shrink-0` and tabular digits.
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
        bin
      </span>
    );
  }
  return (
    <span className={cn("shrink-0 tabular-nums", className)}>
      <span className="text-success">+{format(added)}</span>
      {/* Separator for inline callers (a canonical text space). Flex callers
          bring their own gap and never see it: a whitespace-only anonymous flex
          item is not rendered (CSS Flexbox §4). */}{" "}
      <span className="text-destructive">-{format(deleted)}</span>
    </span>
  );
}
