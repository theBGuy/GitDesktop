import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AriaRole,
  createContext,
  type ReactNode,
  useContext,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { AppSettings } from "@/lib/settings/api";
import {
  settingsKeys,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useContainerWidth } from "@/lib/use-container-width";
import { cn } from "@/lib/utils";

// Below this the surrounding pane can't hold the 288px rail plus a diff wide
// enough to read, so the rail is forced to its strip whatever the preference.
const RAIL_MIN_CONTAINER_PX = 512;

// Names the landmark when the caller's own label belongs to a list role nested
// inside it — one name per element, or landmark navigation announces it twice.
const LANDMARK_LABEL = "File list";

// Width of the row the rail sits in; `null` until measured, and outside a
// DetailRailRow. Unknown reads as "wide" so the rail never flashes collapsed.
const RailWidthContext = createContext<number | null>(null);

/**
 * The rail + detail row. Measures itself so `DetailRail` can decide whether the
 * pane has room for the file list — the measurement has to live on the row, not
 * the rail, since the rail's own width is the thing being decided.
 */
export function DetailRailRow({ children }: { children: ReactNode }) {
  const [measureRef, width] = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={measureRef} className="flex min-h-0 flex-1">
      <RailWidthContext value={width}>{children}</RailWidthContext>
    </div>
  );
}

/**
 * The collapsible file-list rail shared by the diff detail views. Two state
 * layers: the persisted `diffFileListCollapsed` preference governs while the
 * row has room, and a narrow row forces the strip — an explicit expand there is
 * local, never written back, and drops when the row regains room.
 */
export function DetailRail({
  ariaLabel,
  className,
  header,
  role,
  children,
}: {
  ariaLabel: string;
  className?: string;
  /** Rendered start-aligned in the expanded caret strip (e.g. a file count),
   *  which owns the row's height — it must not grow past one short line. */
  header?: ReactNode;
  role?: AriaRole;
  children: ReactNode;
}) {
  const rowWidth = useContext(RailWidthContext);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const panelActive = usePanelActive();
  const [transientExpand, setTransientExpand] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // The expanded-ness a focus-carrying toggle asked for, or null when nothing is
  // pending: each branch renders a different button node, so without the move
  // focus drops to <body>. Armed on a committed flip, and on a rejected write's
  // rollback only while the rail holds focus AND the row is still wide (a narrow
  // rollback can't produce the transition the arm waits for). Every expanded
  // transition consumes the arm, so it can't linger to fire on a later width
  // crossing, pulling focus into a rail the user never touched.
  const refocus = useRef<boolean | null>(null);

  const narrow = rowWidth !== null && rowWidth < RAIL_MIN_CONTAINER_PX;
  // Guarded state-during-render reset — React sanctions this over an effect,
  // which would paint one stale strip frame after the row regains room; same
  // idiom as ui/dialog.tsx and confirm-dialog-host.tsx.
  if (!narrow && transientExpand) setTransientExpand(false);
  const expanded = narrow
    ? transientExpand
    : !settings.data?.diffFileListCollapsed;

  // Rejected-write rollback as an effect event so `narrow` is read at rejection
  // time, not capture time: a rollback landing while the row is narrow can't
  // transition `expanded` (the strip is width-forced), so arming there would
  // leave a live arm for a later width crossing to fire as a focus steal.
  const rollbackCollapsePref = useEffectEvent(
    (previous: AppSettings, attempted: AppSettings) => {
      // Only roll back if this call's change is still the latest: otherwise a
      // late-failing earlier write would stomp a newer successful one.
      const latest = queryClient.getQueryData<AppSettings>(
        settingsKeys.settings,
      );
      if (latest?.diffFileListCollapsed !== attempted.diffFileListCollapsed)
        return;
      // Re-armed for the rollback's own commit, only while the rail still holds
      // focus — a user who has moved on must not have it stolen back.
      refocus.current =
        !narrow && railRef.current?.contains(document.activeElement)
          ? !previous.diffFileListCollapsed
          : null;
      queryClient.setQueryData(settingsKeys.settings, previous);
    },
  );

  const toggle = () => {
    const held = Boolean(railRef.current?.contains(document.activeElement));
    refocus.current = null;
    if (narrow) {
      refocus.current = held ? !transientExpand : null;
      setTransientExpand((prev) => !prev);
      return;
    }
    const current = settings.data;
    if (!current) return;
    const updated = {
      ...current,
      diffFileListCollapsed: !current.diffFileListCollapsed,
    };
    refocus.current = held ? current.diffFileListCollapsed : null;
    // Patch the cache before persisting: the rail has to flip in this commit so
    // the focus move lands on the button that replaced the one focus was on, and
    // so a second press reads the new value instead of re-issuing the old flip.
    queryClient.setQueryData(settingsKeys.settings, updated);
    saveSettings.mutate(updated, {
      onError: () => rollbackCollapsePref(current, updated),
    });
  };
  // Only the visible tab's rail answers the action: <Activity> keeps hidden
  // panels mounted, and its effect teardown is deferred.
  useHotkeyAction("toggle-diff-file-list", toggle, panelActive);

  // Rides the commit that actually renders the new branch — a frame scheduled
  // from the handler could still beat react-query's notify-batched re-render.
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    const matched = refocus.current === expanded;
    refocus.current = null;
    if (matched) toggleRef.current?.focus();
  }, [expanded]);

  if (!expanded) {
    return (
      <aside
        ref={railRef}
        aria-label={role ? LANDMARK_LABEL : ariaLabel}
        className={cn(
          "flex w-7 shrink-0 flex-col items-center border-r",
          className,
        )}
      >
        {/* Same h-7 box as the expanded header strip, so the button doesn't
            shift vertically as the rail toggles. */}
        <div className="flex h-7 shrink-0 items-center">
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-expanded="false"
            aria-label="Expand file list"
            title="Expand file list"
            onClick={toggle}
          >
            <CaretRightIcon />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={railRef}
      aria-label={role ? LANDMARK_LABEL : ariaLabel}
      className={cn("flex w-72 shrink-0 flex-col border-r", className)}
    >
      <div className="flex h-7 shrink-0 items-center justify-end gap-2 border-b px-0.5">
        {/* `pl-2.5` on top of the row's `px-0.5` puts the header's text column on
            the same 12px inset as the `px-3` rows below it. */}
        {header !== undefined && (
          <div className="mr-auto min-w-0 pl-2.5">{header}</div>
        )}
        <Button
          ref={toggleRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded="true"
          aria-label="Collapse file list"
          title="Collapse file list"
          onClick={toggle}
        >
          <CaretLeftIcon />
        </Button>
      </div>
      {/* The caller's role (e.g. listbox) belongs on the list itself — the
          toggle above is not one of its options. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        role={role}
        aria-label={role ? ariaLabel : undefined}
      >
        {children}
      </div>
    </aside>
  );
}
