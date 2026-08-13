import type { MouseEvent } from "react";
import { RelativeTime } from "@/components/relative-time";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/** A commit row, normalized from either git-log (local) or GraphQL (remote). */
export interface CommitRow {
  id: string;
  subject: string;
  shortSha: string;
  author: string;
  date?: string | null;
}

/** Sets a hover title only when the subject is actually clipped by `truncate`;
 *  mirrors the only-when-clipped pattern used across the repo (WorktreesDialog,
 *  BranchSwitcher). Measures `currentTarget`, the `truncate`d element itself. */
const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};

/**
 * The commits tab of a pull request: a scrollable list of commit rows
 * (subject, then short SHA · author · relative time). Shared by the local and
 * remote PR views; each maps its native commit shape to `CommitRow` at the call
 * site so the GraphQL/git field-name divergence stays out of here.
 *
 * Presentational only — no data fetching. When `onSelect` is provided the rows
 * become selectable buttons (click, arrow-key nav, Enter/Space) that drill into
 * a commit detail; without it they render as before (both existing call sites
 * keep compiling unchanged).
 */
export function CommitsList({
  commits,
  emptyMessage,
  onSelect,
  selectedId,
}: {
  commits: CommitRow[];
  emptyMessage?: string;
  /** When present, rows become selectable buttons that call this on activate. */
  onSelect?: (id: string) => void;
  /** The currently-selected row id (only meaningful with `onSelect`). */
  selectedId?: string | null;
}) {
  // Arrow keys walk the list, mirroring the app's other selectable lists; only
  // wired when the list is interactive (onSelect present).
  const onKeyDown = onSelect
    ? listKeyboardNav({
        items: commits,
        activeIndex: commits.findIndex((c) => c.id === selectedId),
        onActivate: (c) => onSelect(c.id),
        rowKey: (c) => c.id,
      })
    : undefined;

  return (
    // overflow-hidden contains the list's natural height (vendored Root is
    // `relative`-only) so a long list can't leak a window scrollbar.
    <ScrollArea className="min-h-0 flex-1 overflow-hidden">
      <div onKeyDown={onKeyDown}>
        {commits.map((c) =>
          onSelect ? (
            <button
              type="button"
              key={c.id}
              data-row={c.id}
              onClick={() => onSelect(c.id)}
              className={cn(
                "block w-full border-b px-4 py-2 text-left",
                selectedId === c.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted/60",
              )}
            >
              <p
                className="truncate text-xs font-medium"
                onMouseEnter={clipTitle(c.subject)}
              >
                {c.subject}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="font-mono">{c.shortSha}</span> · {c.author} ·{" "}
                {c.date && <RelativeTime date={c.date} />}
              </p>
            </button>
          ) : (
            <div key={c.id} className="border-b px-4 py-2">
              <p
                className="truncate text-xs font-medium"
                onMouseEnter={clipTitle(c.subject)}
              >
                {c.subject}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="font-mono">{c.shortSha}</span> · {c.author} ·{" "}
                {c.date && <RelativeTime date={c.date} />}
              </p>
            </div>
          ),
        )}
      </div>
      {commits.length === 0 && emptyMessage && (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      )}
    </ScrollArea>
  );
}
