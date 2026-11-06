import type { BinaryKind } from "@/lib/git/types";
import { cn } from "@/lib/utils";

const BINARY_KIND_LABEL: Record<BinaryKind, string> = {
  mode: "mode",
  renamed: "renamed",
  renamedMode: "renamed",
};

const BINARY_KIND_SR: Record<BinaryKind, string> = {
  mode: "Binary file, mode changed",
  renamed: "Binary file, renamed",
  renamedMode: "Binary file, renamed and mode changed",
};

/**
 * The app's one `+added -deleted` line-count span. The `+`/`-` glyphs carry the
 * meaning on their own, so the success/destructive colors stay decorative
 * (WCAG AA: never color alone). Callers own size and spacing via `className`;
 * this component has no opinion beyond `shrink-0` and tabular digits. The
 * glyphs are `aria-hidden` behind an `sr-only` name span, which is absolutely
 * positioned and so never becomes a flex item in a caller's layout.
 * A binary row's `binaryKind` (wire-sourced, non-null only when the content is
 * proven unchanged) swaps `bin` for "mode"/"renamed"; it is read only when
 * `isBinary` is set, so it can never relabel a counts row.
 */
export function DiffStat({
  added,
  deleted,
  isBinary,
  binaryKind,
  format = String,
  className,
}: {
  added: number;
  deleted: number;
  isBinary?: boolean;
  /** Undefined reads as null: the row keeps `bin`. */
  binaryKind?: BinaryKind | null;
  /** Number formatter for sites that abbreviate (Insights uses `fmt`). */
  format?: (n: number) => string;
  className?: string;
}) {
  if (isBinary) {
    return (
      <span className={cn("shrink-0 text-muted-foreground", className)}>
        <span aria-hidden>
          {binaryKind != null ? BINARY_KIND_LABEL[binaryKind] : "bin"}
        </span>
        <span className="sr-only">
          {binaryKind != null ? BINARY_KIND_SR[binaryKind] : "Binary file"}
        </span>
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

/** The reserved width of a file list's counts cell: `+999 -99`, `bin` and
 *  `renamed` fit, larger counts grow past it. */
const DIFF_STAT_SLOT_CLASS = "min-w-[8ch] text-right";

/**
 * A file-list row's counts cell. It keeps its width whether or not the row has
 * counts yet (they load after the list, and some rows never get them), so a late
 * stat never reflows the file names. Rows render it unconditionally (the
 * `list-row-diff-stat-slot` guard bans a conditional DiffStat cell).
 */
export function DiffStatSlot({
  stat,
  className,
}: {
  /** Absent = no counts (yet, or ever): an empty cell of the same width. */
  stat?: {
    added: number;
    deleted: number;
    isBinary?: boolean;
    binaryKind?: BinaryKind | null;
  };
  className?: string;
}) {
  if (!stat) {
    return (
      <span
        aria-hidden
        className={cn("shrink-0", DIFF_STAT_SLOT_CLASS, className)}
      />
    );
  }
  return (
    <DiffStat
      added={stat.added}
      deleted={stat.deleted}
      isBinary={stat.isBinary}
      binaryKind={stat.binaryKind}
      className={cn(DIFF_STAT_SLOT_CLASS, className)}
    />
  );
}
