import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * One row placeholder: the same flush `border-b px-3 py-2` box and per-line
 * rhythm as the real rows, so real rows replace skeletons without shifting the
 * list. Bars run full width — the real lines truncate across the row. With
 * `indent` (the default) lines after the first sit where icon-led rows put
 * their meta lines (≈ their `pl-4`/`pl-5`); avatar-column lists, whose lines
 * share one left edge, pass `indent={false}`. `lines` must match the real
 * row's line count (2 = issue rows, 3 = PR / workflow-run / Jira rows).
 * Callers render `ListRowSkeletons` instead — it wraps this one with the busy
 * announcement a loading region owes readers.
 */
function ListRowSkeleton({ lines, indent }: { lines: 2 | 3; indent: boolean }) {
  return (
    <div className="border-b px-3 py-2">
      {/* Index key: a fixed static list that never reorders. */}
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-4", i > 0 && "mt-0.5", i > 0 && indent && "ml-4")}
        />
      ))}
    </div>
  );
}

/**
 * A loading section's rows, announced once for the whole group rather than per
 * row. `name` names the content as a reader hears it — "Loading pull requests…".
 */
export function ListRowSkeletons({
  rows,
  lines,
  name,
  indent = true,
}: {
  rows: number;
  lines: 2 | 3;
  name: string;
  indent?: boolean;
}) {
  return (
    <div aria-busy>
      {/* aria-busy alone has no text; role="status" gives the busy region words
          for readers that announce it. */}
      <span role="status" className="sr-only">
        Loading {name}…
      </span>
      {/* Index key: a fixed static list that never reorders. */}
      {Array.from({ length: rows }, (_, i) => (
        <ListRowSkeleton key={i} lines={lines} indent={indent} />
      ))}
    </div>
  );
}
