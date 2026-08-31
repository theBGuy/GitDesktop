import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Per-line bar widths, staggered so the shimmer reads as lines of text. */
const BAR_WIDTHS = ["w-3/5", "w-2/5", "w-1/2"];

/**
 * One row placeholder: the same flush `border-b px-3 py-2` box and per-line
 * rhythm as the real rows, so real rows replace skeletons without shifting the
 * list. `lines` must match the real row's line count (2 = issue rows, 3 = PR /
 * workflow-run / Jira rows). Callers render `ListRowSkeletons` instead — it
 * wraps this one with the busy announcement a loading region owes readers.
 */
export function ListRowSkeleton({ lines }: { lines: 2 | 3 }) {
  return (
    <div className="border-b px-3 py-2">
      {/* Index key: a fixed static list that never reorders. */}
      {BAR_WIDTHS.slice(0, lines).map((width, i) => (
        <Skeleton key={i} className={cn("h-4", width, i > 0 && "mt-0.5")} />
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
}: {
  rows: number;
  lines: 2 | 3;
  name: string;
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
        <ListRowSkeleton key={i} lines={lines} />
      ))}
    </div>
  );
}
