import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { HeldFrame, heldParentProps } from "@/components/held-frame";
import type { EntityHoldSlot, EntitySlotRole } from "@/lib/entity-hold";
import { useEntityHold, useRevealGuard } from "@/lib/use-entity-hold";

/** What a run slot tells the run view inside it. Its own context, not the diff
 *  pane's: DiffSurfaces nested in other detail views read that one. */
export interface RunSlotHoldValue {
  /** Shown (not held or preparing) AND its run is the live selection, since
   *  the shown slot still names the old run until the deferred id catches up.
   *  Gates the global hotkeys, which `inert` doesn't stop, and the debug
   *  dialog's permanent close. */
  interactive: boolean;
  /** This slot is the shown one (not held or preparing). Outside a slot: true.
   *  Gates the loading frame's announcement mount. */
  shown: boolean;
  /** Records the slot's settle state and returns its release. */
  reportSettled: (settled: boolean) => () => void;
}

const release = () => undefined;

const OUTSIDE_SLOT: RunSlotHoldValue = {
  interactive: true,
  shown: true,
  reportSettled: () => release,
};

const RunSlotHold = createContext<RunSlotHoldValue>(OUTSIDE_SLOT);

/** For interaction gates: handlers, hotkeys, palette rows. */
export function useRunSlotInteractive(): boolean {
  return useContext(RunSlotHold).interactive;
}

/** For the loading frame: its status mounts afresh when the slot shows, since
 *  a live region inserted while out of sight is not reliably announced. */
export function useRunSlotShown(): boolean {
  return useContext(RunSlotHold).shown;
}

/** Reports whether the run view has an answer to show (a final error or
 *  offline notice counts). Call it before any early return. A layout effect, so
 *  a settle promotes the slot before the browser paints the frame it settled
 *  in. */
export function useReportRunSettled(settled: boolean): void {
  const { reportSettled } = useContext(RunSlotHold);
  useLayoutEffect(() => reportSettled(settled), [reportSettled, settled]);
}

const SLOT_CLASS: Record<EntitySlotRole, string> = {
  shown: "h-full",
  held: "h-full",
  // Stacked over the held run at full size, so it lays out before it shows,
  // and hidden by a full clip (inert keeps it out of pointer, focus and AT).
  // Never `invisible`: the vendored Button transitions inherited visibility, so
  // every button would paint a frame late when the slot shows.
  preparing: "absolute inset-0 [clip-path:inset(50%)]",
};

/**
 * The Actions tab's run detail as a two-slot hold: moving to another run keeps
 * the last settled one painted (dimmed, inert) while the new one prepares out of
 * sight, promoted on its first settled report or the entity-hold bound. Each
 * slot is its own keyed instance, so per-run state never crosses runs. Callers
 * key this on the repo: a repo switch starts over without a hold. A reveal that
 * also moves the run (openRun, the branch CI badge) renders the live run as the
 * shown slot (its view paints the loading frame until it loads), never the one
 * a hold would keep.
 */
export function RunSlots({
  runId,
  liveRunId,
  visible,
  renderRun,
}: {
  /** The run this render targets: the caller's deferred selection. */
  runId: number;
  /** The store's selection, urgent. */
  liveRunId: number | null;
  /** The Actions tab is visible now (urgent, never deferred). */
  visible: boolean;
  renderRun: (runId: number) => ReactNode;
}) {
  const key = String(runId);
  // Each mounted slot's latest settle report, by run key.
  const [reports, setReports] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  // The hold's shown run as of its last step, for the guard below, which runs
  // before this render's step.
  const [lastShown, setLastShown] = useState(key);
  const reveal = useRevealGuard({
    visible,
    liveKey: liveRunId === null ? null : String(liveRunId),
    viewKey: key,
    shownKey: lastShown,
  });
  const hold = useEntityHold({
    key,
    settled: reports.get(key) === true,
    // Every key here is a run of the one repo this host is keyed on, and the
    // hold itself refuses an unsettled shown run.
    canHold: true,
    // A paused read reports settled (its offline notice is final), so the hold
    // never waits on one.
    paused: false,
    active: reveal.active,
  });
  if (lastShown !== hold.shownKey) setLastShown(hold.shownKey);
  const onReport = useCallback(
    (slotKey: string, settled: boolean | null) =>
      setReports((prev) => {
        if (settled === null) {
          if (!prev.has(slotKey)) return prev;
          const next = new Map(prev);
          next.delete(slotKey);
          return next;
        }
        return prev.get(slotKey) === settled
          ? prev
          : new Map(prev).set(slotKey, settled);
      }),
    [],
  );
  // The reveal slot shares the key and position of the shown slot the hold
  // lands on once the deferred id catches up, so that view never remounts.
  const revealSlots: EntityHoldSlot[] =
    liveRunId === null ? [] : [{ key: String(liveRunId), role: "shown" }];
  const slots = reveal.revealing ? revealSlots : hold.slots;
  return (
    // The busy signal lives here: the held slot is inert, and an inert subtree
    // is out of the accessibility tree along with its aria-busy. A reveal paints
    // no held slot, so it never claims busy over the frame's own status.
    <div
      className="relative h-full"
      {...heldParentProps(hold.holding && !reveal.revealing)}
    >
      {slots.map(({ key: slotKey, role }) => (
        <RunSlot
          key={slotKey}
          slotKey={slotKey}
          role={role}
          live={liveRunId !== null && String(liveRunId) === slotKey}
          onReport={onReport}
        >
          {renderRun(Number(slotKey))}
        </RunSlot>
      ))}
    </div>
  );
}

function RunSlot({
  slotKey,
  role,
  live,
  onReport,
  children,
}: {
  slotKey: string;
  role: EntitySlotRole;
  /** This slot's run is the store's (urgent) selection. */
  live: boolean;
  onReport: (slotKey: string, settled: boolean | null) => void;
  children: ReactNode;
}) {
  // Stable across role changes: the run view's report effect depends on it,
  // and a fresh function would re-report on every promotion.
  const reportSettled = useCallback(
    (settled: boolean) => {
      onReport(slotKey, settled);
      return () => onReport(slotKey, null);
    },
    [slotKey, onReport],
  );
  // Memoized for identity: the context reaches the whole run view.
  const value = useMemo<RunSlotHoldValue>(
    () => ({
      interactive: role === "shown" && live,
      shown: role === "shown",
      reportSettled,
    }),
    [role, live, reportSettled],
  );
  return (
    <HeldFrame
      holding={role === "held"}
      inert={role === "preparing"}
      className={SLOT_CLASS[role]}
    >
      <RunSlotHold value={value}>{children}</RunSlotHold>
    </HeldFrame>
  );
}
