import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Per-line bar widths, staggered so the shimmer reads as lines of text. */
const BAR_WIDTHS = ["w-3/5", "w-2/5", "w-1/2"];

/**
 * A placeholder shaped like one row of a bordered list: the same flush
 * `border-b px-3 py-2` box and per-line rhythm as the real rows, so real rows
 * replace skeletons without shifting the list. `lines` must match the real
 * row's line count (2 = issue rows, 3 = PR / workflow-run / Jira rows).
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
