import type { ReactNode } from "react";

/** A blank grid cell reads as a broken render, so an empty field says it has
 *  nothing instead. Decorative — the cell's own label already names the field. */
const EMPTY_CELL = (
  <span aria-hidden className="text-muted-foreground">
    —
  </span>
);

/**
 * The value half of a header meta field (labels, assignees, projects,
 * reviewers), paired in the grid with either its picker's trigger or a
 * `MetaFieldLabel`. role="group" plus the field name is what ties a value to
 * its field for assistive tech, the label column being a separate cell.
 * `min-h-6` matches the ghost xs trigger's box so short content shares the
 * row's centerline under the grid's `items-start`.
 */
export function MetaValueCell({
  label,
  empty = false,
  children,
}: {
  label: string;
  /** The field holds nothing — render the placeholder rather than `children`. */
  empty?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-h-6 min-w-0 flex-wrap items-center gap-1.5"
    >
      {empty ? EMPTY_CELL : children}
    </div>
  );
}

/** The label half of a meta field with no picker — a closed PR, or a provider
 *  that lacks it. The inset matches a ghost xs trigger's own text (a 1px
 *  transparent border + pl-1.5 + a size-3 icon + gap-1), so a column mixing
 *  static labels with triggers shares one text edge. */
export function MetaFieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-h-6 items-center pl-[23px] text-xs text-muted-foreground">
      {children}
    </span>
  );
}
