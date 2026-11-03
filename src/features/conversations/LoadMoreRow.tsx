import { CircleNotchIcon } from "@phosphor-icons/react";

/** The number of items a list loads per page; "Load more" bumps a panel's limit
 *  by this. A deliberate bump from the old silent gh-CLI defaults (30 PRs/issues,
 *  50 discussions) so the first page shows far more before anyone needs to page. */
export const PAGE_SIZE = 100;

/** A focusable, full-width row rendered at the very bottom of a list when it may
 *  have more items server-side (the returned count filled the requested limit).
 *  A real `<button>` so it's Tab-reachable; the arrow-key row nav covers list
 *  rows only and intentionally skips this. While the grown query refetches, the
 *  button disables and shows a spinner so the click has visible feedback. */
export function LoadMoreRow(props: {
  /** How many items are currently loaded (formatted plainly). */
  count: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const { count, loading, onLoadMore } = props;
  return (
    <div className="border-t p-2">
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loading}
        className="flex w-full cursor-pointer flex-col items-center gap-0.5 rounded px-3 py-2 text-xs hover:bg-muted/60 disabled:cursor-default disabled:opacity-70"
      >
        <span className="flex items-center gap-1.5 font-medium">
          {/* Raw <button>, not the vendored Button — so the `data-icon` marker
              wouldn't apply its size/gap; size the spinner + set the gap here.
              Icon matches the app's loading idiom (status.tsx: CircleNotchIcon +
              animate-spin). Rendered only while loading; the label swaps too, so
              there's no reserved-slot shift to manage. */}
          {loading && <CircleNotchIcon className="size-3 animate-spin" />}
          {loading ? "Loading…" : `Load ${PAGE_SIZE} more`}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          Showing first {count.toLocaleString()}
        </span>
      </button>
    </div>
  );
}

/** Takes the Load more row's slot when the list's read stopped at its horizon,
 *  where another page would re-read the same rows. Same box and hierarchy as
 *  LoadMoreRow, but static text: nothing to focus or announce. */
export function ListCapNote(props: {
  /** How many items are currently loaded. */
  count: number;
  /** The list's plural noun ("merge requests"). */
  noun: string;
}) {
  const { count, noun } = props;
  return (
    <div className="border-t p-2">
      <div className="flex flex-col items-center gap-0.5 px-3 py-2">
        <span className="text-xs font-medium tabular-nums">
          Showing the newest {count.toLocaleString()}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Use Filters to reach older {noun}
        </span>
      </div>
    </div>
  );
}
