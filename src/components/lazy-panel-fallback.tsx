import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Fill for a surface with no distinctive loading shape. */
const DEFAULT_ROWS = ["h-8 w-full", "h-8 w-full", "h-8 w-2/3"];

/**
 * What a lazily-loaded panel shows while its chunk arrives, so the region keeps
 * a shape instead of going blank and the wait reaches a screen reader. Callers
 * pass their own geometry so the swap to the loaded panel doesn't shift layout.
 */
export function LazyPanelFallback({
  name,
  className,
  rows = DEFAULT_ROWS,
}: {
  /** Names this surface as a screen reader reads it — "Loading insights…". */
  name: string;
  /** Lays the rows out; a `grid` class replaces the default column. */
  className?: string;
  /** One Skeleton per entry, the entry being its size classes. */
  rows?: readonly string[];
}) {
  return (
    <div
      aria-busy
      className={cn("flex h-full min-h-0 flex-col gap-2 p-2", className)}
    >
      {/* aria-busy alone announces nothing outside a live region, so the state
          gets words a screen reader will actually read. */}
      <span className="sr-only">Loading {name}…</span>
      {/* Index key: the rows are static and never reorder, and two rows may
          share the same size classes. */}
      {rows.map((row, i) => (
        <Skeleton key={i} className={row} />
      ))}
    </div>
  );
}
