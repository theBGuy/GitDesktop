import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { memo } from "react";
import { DiffStat } from "@/components/diff-stat";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { KIND_BADGE } from "@/lib/git/change-kind-badge";
import { reservedDeviceName } from "@/lib/git/reserved-device-name";
import type { ChangeKind, DiffStatEntry, FileEntry } from "@/lib/git/types";
import { cn } from "@/lib/utils";

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
  stat,
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
  /** This row's OWN side of the diff (staged rows: index vs HEAD; unstaged:
   *  working tree vs index). Absent = no counts to show. */
  stat?: DiffStatEntry;
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
  // Staging is the only direction that reads the working-tree file, so only it
  // hits the device; unstaging works on such a path as on any other.
  const reservedName = staged ? null : reservedDeviceName(entry.path);

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
      <span
        aria-hidden
        className={cn("w-3 shrink-0 font-semibold", badge.className)}
      >
        {badge.letter}
      </span>
      {/* The status letter carries no meaning for assistive tech; the name span
          sits ahead of the path so the kind is announced first, and `sr-only`
          is absolutely positioned so it never becomes a flex item here. The
          trailing space keeps the name from fusing with the path text. */}
      <span className="sr-only">{badge.label} </span>
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {stat ? (
        <DiffStat
          added={stat.added}
          deleted={stat.deleted}
          isBinary={stat.isBinary}
          className="text-[11px]"
        />
      ) : null}
      <DisabledReasonButton
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
        disabled={disabled || reservedName !== null}
        reason={
          reservedName &&
          `"${reservedName}" is a Windows-reserved device name — git can't stage it`
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle(entry, staged);
        }}
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </DisabledReasonButton>
    </div>
  );
});
