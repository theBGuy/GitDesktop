import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { cn } from "@/lib/utils";

const KIND_BADGE: Record<ChangeKind, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success" },
  untracked: { letter: "U", className: "text-success" },
  modified: { letter: "M", className: "text-warning" },
  typechange: { letter: "T", className: "text-warning" },
  deleted: { letter: "D", className: "text-destructive" },
  renamed: { letter: "R", className: "text-info" },
  copied: { letter: "C", className: "text-info" },
  conflicted: { letter: "!", className: "text-destructive" },
};

/**
 * A single changed-file row. Deliberately light: it carries no context menu or
 * data hooks of its own (those live in one shared menu at the panel level, so a
 * list of thousands of files doesn't mount thousands of portals). `memo` keeps a
 * selection change from re-rendering every windowed row — only the rows whose
 * `selected`/`active` actually flip.
 */
export const FileRow = memo(function FileRow({
  entry,
  kind,
  staged,
  selected,
  active,
  disabled,
  onSelect,
  onToggle,
}: {
  entry: FileEntry;
  kind: ChangeKind;
  staged: boolean;
  /** Part of the multi-selection (drives the row highlight). */
  selected: boolean;
  /** The active row whose diff is shown (keeps its toggle button visible). */
  active: boolean;
  disabled: boolean;
  onSelect: (
    entry: FileEntry,
    staged: boolean,
    mods: { ctrlOrMeta: boolean; shift: boolean },
  ) => void;
  onToggle: (entry: FileEntry, staged: boolean) => void;
}) {
  const badge = KIND_BADGE[kind];
  const label = entry.origPath
    ? `${entry.origPath} → ${entry.path}`
    : entry.path;

  return (
    <div
      data-row={`${staged ? "staged" : "unstaged"}:${entry.path}`}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
      onClick={(e) =>
        onSelect(entry, staged, {
          ctrlOrMeta: e.ctrlKey || e.metaKey,
          shift: e.shiftKey,
        })
      }
      onKeyDown={(e) => {
        // Keys from the nested toggle button pass through untouched, or the
        // preventDefault below would cancel its native Enter/Space activation.
        if (e.target !== e.currentTarget) return;
        // Space on the row itself must be swallowed or it scrolls the list.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry, staged, { ctrlOrMeta: false, shift: false });
        }
      }}
      role="option"
      aria-selected={selected}
      tabIndex={0}
    >
      <span className={cn("w-3 shrink-0 font-semibold", badge.className)}>
        {badge.letter}
      </span>
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          // Hover reveals the toggle; keep it visible on the active row (the one
          // whose diff is shown) and any selected row so keyboard navigation and
          // the current selection always expose the action.
          "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
          (active || selected) && "opacity-100",
        )}
        aria-label={staged ? `Unstage ${entry.path}` : `Stage ${entry.path}`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(entry, staged);
        }}
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </Button>
    </div>
  );
});
