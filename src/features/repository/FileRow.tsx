import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { memo, useRef } from "react";
import { toast } from "sonner";
import { DiffStatSlot } from "@/components/diff-stat";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { PathText } from "@/components/path-text";
import { Badge } from "@/components/ui/badge";
import { clipTitleFromText } from "@/lib/clip-title";
import { KIND_BADGE } from "@/lib/git/change-kind-badge";
import { reservedDeviceName } from "@/lib/git/reserved-device-name";
import type { ChangeKind, DiffStatEntry, FileEntry } from "@/lib/git/types";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { pathBasename } from "@/lib/path-tree";
import { cn } from "@/lib/utils";
import {
  SUBMODULE_NOTHING_TO_STAGE,
  submoduleStageBlocked,
  submoduleWords,
} from "./submodule-row";

/** Why a reserved-device-name row can't stage — shared by the row's disabled
 *  toggle button and its Space key so the two can't drift. */
export function reservedStageReason(name: string): string {
  return `"${name}" resolves to a Windows device name — git can't stage it`;
}

/** Said when a stage is refused while a conflicted stage's marker check is
 *  still running — by the row's Space and the panel's other stage routes. */
export const MARKER_CHECK_PENDING = "Still checking files for conflict markers";

/** How long after a +/- press a double-click on the row still counts as that
 *  press's own pair, so it never opens the file. */
const TOGGLE_DBLCLICK_MS = 600;

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
  checking,
  tabStop,
  stat,
  treeDisplay,
  indentPx,
  onSelect,
  onToggle,
  onOpen,
}: {
  entry: FileEntry;
  kind: ChangeKind;
  staged: boolean;
  /** Part of the multi-selection (drives the row highlight). */
  selected: boolean;
  /** The active row whose diff is shown (keeps its toggle button visible). */
  active: boolean;
  disabled: boolean;
  /** A conflicted stage's marker check is running (part of `disabled`): Space
   *  says so rather than failing silently. */
  checking: boolean;
  /** This row is the list's single roving tab stop (its toggle button rides
   *  along). A boolean, like `selected`, so a stop move re-renders two rows. */
  tabStop: boolean;
  /** This row's OWN side of the diff (staged rows: index vs HEAD; unstaged:
   *  working tree vs index). Absent = a blank, still-reserved counts cell. */
  stat?: DiffStatEntry;
  /** Tree mode: render only the basename(s); the row carries a static full-path title. */
  treeDisplay?: boolean;
  /** Tree mode: depth indent in px, applied as style paddingLeft on top of the row's base. */
  indentPx?: number;
  onSelect: (
    entry: FileEntry,
    staged: boolean,
    mods: { ctrlOrMeta: boolean; shift: boolean },
  ) => void;
  onToggle: (entry: FileEntry, staged: boolean) => void;
  /** Double-click: open the file (opening is no mutation, so `disabled` and
   *  `checking` don't gate it). */
  onOpen: (entry: FileEntry, staged: boolean) => void;
}) {
  const badge = KIND_BADGE[kind];
  const lastToggleClick = useRef(Number.NEGATIVE_INFINITY);
  const label = entry.origPath
    ? `${entry.origPath} → ${entry.path}`
    : entry.path;
  // Staging is the only direction that reads the working-tree file, so only it
  // hits the device; unstaging works on such a path as on any other.
  const reservedName = staged ? null : reservedDeviceName(entry.path);
  const submoduleBlocked = submoduleStageBlocked(entry, staged);
  // A reserved name outranks the submodule reason, as in the menu.
  let stageReason: string | null = null;
  if (reservedName !== null) stageReason = reservedStageReason(reservedName);
  else if (submoduleBlocked) stageReason = SUBMODULE_NOTHING_TO_STAGE;
  const isSubmodule = entry.submodule !== undefined;
  const words = submoduleWords(entry, staged);
  // The name cell. A rename is two paths and an arrow, and tree mode shows
  // basenames (the folder row above carries the directory): the wrapper's title
  // only wins while nothing is clipped, so each PathText also carries the full
  // path it stands for as its own only-when-clipped tooltip.
  let nameCell = <PathText path={entry.path} className="flex-1" />;
  if (entry.origPath) {
    nameCell = (
      <span
        aria-hidden={treeDisplay || undefined}
        className="flex min-w-0 flex-1 items-center gap-1"
        title={label}
      >
        <PathText
          path={treeDisplay ? pathBasename(entry.origPath) : entry.origPath}
          title={label}
        />
        <span className="shrink-0">→</span>
        <PathText
          path={treeDisplay ? pathBasename(entry.path) : entry.path}
          title={label}
        />
      </span>
    );
  } else if (treeDisplay) {
    nameCell = (
      <span aria-hidden className="flex min-w-0 flex-1" title={label}>
        <PathText
          path={pathBasename(entry.path)}
          title={entry.path}
          className="min-w-0 flex-1"
        />
      </span>
    );
  }

  return (
    <div
      data-row={`${staged ? "staged" : "unstaged"}:${entry.path}`}
      style={indentPx === undefined ? undefined : { paddingLeft: 8 + indentPx }}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-xs select-none",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
      onClick={(e) => {
        const ctrlOrMeta = e.ctrlKey || e.metaKey;
        // A modified double-click's second click would toggle the row back:
        // the pair selects as one Ctrl-click does.
        if (ctrlOrMeta && e.detail > 1) return;
        onSelect(entry, staged, { ctrlOrMeta, shift: e.shiftKey });
      }}
      onDoubleClick={(e) => {
        // The toggle's stopPropagation covers click only, so its dblclick
        // bubbles here. A first click that staged the row disables the button
        // (no pointer events), so the pair's rest lands on the row itself.
        const button =
          e.target instanceof Element ? e.target.closest("button") : null;
        if (button !== null && e.currentTarget.contains(button)) return;
        if (performance.now() - lastToggleClick.current < TOGGLE_DBLCLICK_MS)
          return;
        onOpen(entry, staged);
      }}
      onKeyDown={(e) => {
        // Keys from the nested toggle button pass through untouched (its native
        // Enter/Space activation), and chords pass to the window listener.
        if (e.target !== e.currentTarget || hasChordModifier(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onSelect(entry, staged, { ctrlOrMeta: false, shift: false });
        } else if (e.key === " ") {
          e.preventDefault(); // every Space variant below: no list scroll
          if (e.repeat || e.shiftKey) return; // held key acts once; Shift+Space reserved
          if (reservedName !== null) {
            toast.info(reservedStageReason(reservedName));
            return;
          }
          if (submoduleBlocked) {
            toast.info(SUBMODULE_NOTHING_TO_STAGE);
            return;
          }
          if (checking) {
            toast.info(MARKER_CHECK_PENDING);
            return;
          }
          if (disabled) return; // silent no-op, matching the disabled +/- button
          onToggle(entry, staged);
        }
      }}
      role="option"
      // A submodule row's inline path, tag and words would fuse into one word
      // as a content-derived name, so it names itself from the same strings.
      aria-label={
        isSubmodule
          ? [`${badge.label} ${label}`, "Submodule", words]
              .filter((part) => part !== "")
              .join(", ")
          : undefined
      }
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
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
          trailing space keeps the name from fusing with the path text. Tree
          mode's visible cell shows basenames, so the full path(s) ride here
          instead and that cell is `aria-hidden` — otherwise the basename is
          announced twice and same-named files in different folders alike. */}
      <span className="sr-only">
        {treeDisplay ? `${badge.label} ${label} ` : `${badge.label} `}
      </span>
      {isSubmodule ? (
        <>
          {/* Basis auto, so the words below shrink first and the path keeps
              its characters; the tag never shrinks. */}
          <span className="flex min-w-0 flex-auto">{nameCell}</span>
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
            Submodule
          </Badge>
          {/* No DiffStatSlot: these words arrive with the row, so nothing
              lands late to reflow the names. */}
          {words !== "" && (
            <span
              className="min-w-0 truncate text-[11px] text-muted-foreground [flex:0_9999_auto]"
              onMouseEnter={clipTitleFromText}
            >
              {words}
            </span>
          )}
        </>
      ) : (
        <>
          {nameCell}
          <DiffStatSlot stat={stat} className="text-[11px]" />
        </>
      )}
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
        tabIndex={tabStop ? 0 : -1}
        disabled={disabled || stageReason !== null}
        reason={stageReason}
        onClick={(e) => {
          e.stopPropagation();
          lastToggleClick.current = performance.now();
          onToggle(entry, staged);
        }}
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </DisabledReasonButton>
    </div>
  );
});
