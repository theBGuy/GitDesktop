import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";
import {
  DiffPaneHold,
  type DiffPaneHoldValue,
  useDiffPaneHold,
} from "./diff-pane-hold";
import {
  expirePane,
  HOLD_BOUND_MS,
  heldRetained,
  isHolding,
  type PaneHold,
  type PaneView,
  paneSlots,
  retargetPane,
  type SlotPhase,
  settlePane,
  slotWidget,
  startPaneHold,
} from "./diff-pane-slots";

// The diff panes' file slots, shared by the Changes pane and every file-rail
// host. Imports stay this light (never ./DiffSurface): hosts outside the diff
// feature render it eagerly, and the heavy diff chunk must stay off their path.

export {
  keyedPaneView,
  type PaneView,
  placeholderPaneView,
} from "./diff-pane-slots";

const SLOT_FRAME_CLASS: Record<SlotPhase, string> = {
  shown: "h-full",
  held: "h-full",
  // Stacked over the held slot (absolute, rendered after it) at full size, so
  // container queries, the split/unified measure and row measurement are final
  // before it shows. Hidden by a full clip, never `invisible`: the vendored
  // Button's transition-all animates inherited visibility, so its buttons would
  // paint a frame late at promotion. Never opacity either: the frame's
  // PLACEHOLDER_FADE would fade the slot in instead of showing it at once.
  preparing: "absolute inset-0 [clip-path:inset(50%)]",
};

/** A host's no-file placeholder or a conflict view. Only the placeholder is
 *  ever held (a first selection prepares out of sight, clipped over it), and
 *  undimmed: it isn't content. */
function PaneFrame({ held, children }: { held: boolean; children: ReactNode }) {
  return (
    <div className="h-full" inert={held}>
      {children}
    </div>
  );
}

/**
 * One file's slot. Its surfaces report their loading gates here; the slot is
 * settled once at least one gate has reported and every reported gate is
 * settled, and it reports each change of that state up: settling promotes it
 * while it is the preparing target, and either edge updates the shown file's
 * settle. A render-null arm that never reports is invisible to that check, so
 * each one reports. Held and preparing slots are inert and non-interactive.
 */
function FileSlot({
  slotKey,
  repo,
  entity,
  phase,
  onSettled,
  focusRescue,
  children,
}: {
  slotKey: string;
  repo: string;
  entity: string;
  phase: SlotPhase;
  onSettled: (
    key: string,
    repo: string,
    entity: string,
    settled: boolean,
  ) => void;
  focusRescue: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [gates, setGates] = useState<ReadonlyMap<object, boolean>>(
    () => new Map(),
  );
  // Stable on purpose: every gate's layout effect depends on it, so a fresh
  // function per render would re-register them all in a loop.
  const reportSettled = useCallback((settled: boolean) => {
    const gate = {};
    setGates((prev) => new Map(prev).set(gate, settled));
    return () =>
      setGates((prev) => {
        const next = new Map(prev);
        next.delete(gate);
        return next;
      });
  }, []);
  const settled = gates.size > 0 && Array.from(gates.values()).every(Boolean);
  // Both edges: a shown slot that goes loading again (Raw to Preview, a
  // rebuild's measure gap) must not be held by the next click.
  useLayoutEffect(() => {
    onSettled(slotKey, repo, entity, settled);
  }, [settled, slotKey, repo, entity, onSettled]);
  // `inert` blurs a focused descendant to <body> after this commit; hand focus
  // to the pane's sink first.
  useLayoutEffect(() => {
    if (phase === "held" && frameRef.current?.contains(document.activeElement))
      focusRescue.current?.focus({ preventScroll: true });
  }, [phase, focusRescue]);
  // Memoized for identity: the context reaches every gate in the slot.
  const hold = useMemo<DiffPaneHoldValue>(
    () => ({ interactive: phase === "shown", phase, reportSettled }),
    [phase, reportSettled],
  );
  return (
    <div
      ref={frameRef}
      className={cn(
        SLOT_FRAME_CLASS[phase],
        PLACEHOLDER_FADE,
        // The delay keeps a fast swap from flashing a half-dimmed pane.
        phase === "held" && "opacity-80 delay-100",
      )}
      inert={phase !== "shown"}
    >
      <DiffPaneHold value={hold}>{children}</DiffPaneHold>
    </div>
  );
}

/** What the shown slot's own read is doing, as its child reports it: a host's
 *  dim and busy follow it, since the read lives in the slot. */
export interface SlotRead {
  /** Serving another key's retained answer (an entity change). */
  placeholder: boolean;
  /** Nothing to show yet, and not parked offline. */
  loading: boolean;
}

const NO_READ: SlotRead = { placeholder: false, loading: false };

export interface FileSlotsState<F> {
  hold: PaneHold<F>;
  holding: boolean;
  read: SlotRead;
  /** Stable; for {@link useSlotRead}. */
  reportRead: (read: SlotRead) => void;
  onSettled: (
    key: string,
    repo: string,
    entity: string,
    settled: boolean,
  ) => void;
  /** Where focus inside a slot that turns held lands; also a landing for a
   *  host's own focus moves that leave the pane with nothing to focus. */
  sinkRef: RefObject<HTMLSpanElement | null>;
}

/**
 * The two-slot hold over a pane's target: the last settled view stays painted
 * while a newly selected file prepares out of sight, clipped over it, so a
 * click swaps the pane once (see diff-pane-slots.ts). The bound re-arms per
 * target, so arrowing a rail never pins a stale file past it. Call before any
 * early return; render the slots with {@link FileSlots}.
 */
export function useFileSlots<F>(target: PaneView<F>): FileSlotsState<F> {
  const [storedHold, setHold] = useState(() => startPaneHold(target));
  const hold = retargetPane(storedHold, target);
  if (hold !== storedHold) setHold(hold);
  const holding = isHolding(hold);
  const preparing = holding && hold.target.kind === "file" ? hold.target : null;
  const preparingKey = preparing?.key ?? null;
  const preparingEntity = preparing?.entity ?? null;
  useEffect(() => {
    if (preparingKey === null || preparingEntity === null) return;
    const bound = window.setTimeout(
      () => setHold((h) => expirePane(h, preparingKey, preparingEntity)),
      HOLD_BOUND_MS,
    );
    return () => window.clearTimeout(bound);
  }, [preparingKey, preparingEntity]);
  const onSettled = useCallback(
    (key: string, repo: string, entity: string, settled: boolean) =>
      setHold((h) => settlePane(h, key, repo, entity, settled)),
    [],
  );
  const [read, setRead] = useState(NO_READ);
  const reportRead = useCallback(
    (next: SlotRead) =>
      setRead((prev) =>
        prev.placeholder === next.placeholder && prev.loading === next.loading
          ? prev
          : next,
      ),
    [],
  );
  const sinkRef = useRef<HTMLSpanElement>(null);
  return { hold, holding, read, reportRead, onSettled, sinkRef };
}

/**
 * The pane's slots, in paint order, behind its focus sink. `children` renders
 * one view; a held slot paints the view it settled with, the live slot this
 * render's `target` (same identity, the freshest object). `busy` goes on this
 * root, which stays out of `inert`: an inert subtree is out of the
 * accessibility tree along with its aria-busy.
 */
export function FileSlots<F>({
  slots,
  target,
  busy,
  children,
}: {
  slots: FileSlotsState<F>;
  target: PaneView<F>;
  busy?: boolean;
  children: (view: PaneView<F>) => ReactNode;
}) {
  return (
    <div className="relative h-full" aria-busy={busy || undefined}>
      {/* A sibling of the slots, never an ancestor: a focusable ancestor would
          take focus on every click into the code and swallow keyboard
          scrolling. */}
      <span ref={slots.sinkRef} tabIndex={-1} className="sr-only" />
      {paneSlots(slots.hold).map(({ view: slotView, phase, slotId }) => {
        const view = phase === "held" ? slotView : target;
        return view.kind === "file" ? (
          <FileSlot
            key={slotId}
            slotKey={view.key}
            repo={view.repo}
            entity={view.entity}
            phase={phase}
            onSettled={slots.onSettled}
            focusRescue={slots.sinkRef}
          >
            {children(view)}
          </FileSlot>
        ) : (
          <PaneFrame key={slotId} held={phase === "held"}>
            {children(view)}
          </PaneFrame>
        );
      })}
    </div>
  );
}

/**
 * A host slot child's read. While this slot is the shown one it reports the
 * read up (the host's dim and busy). While the read serves another key's
 * answer the slot stays unsettled, so the next click replaces that paint
 * instead of holding a previous entity's file under the new one's header.
 */
export function useSlotRead(
  report: (read: SlotRead) => void,
  read: { isPlaceholderData: boolean; isPending: boolean; isPaused?: boolean },
): void {
  const { interactive, reportSettled } = useDiffPaneHold();
  const placeholder = read.isPlaceholderData;
  const loading = read.isPending && !read.isPaused;
  useLayoutEffect(
    () => (placeholder ? reportSettled(false) : undefined),
    [placeholder, reportSettled],
  );
  useLayoutEffect(() => {
    if (!interactive) return;
    report({ placeholder, loading });
    return () => report(NO_READ);
  }, [interactive, placeholder, loading, report]);
}

/** A slot's line-comment widget, per `slotWidget`: a held slot keeps the one
 *  it had while shown, so an open composer stays mounted as it was and the
 *  rows don't shift; the slot's `inert` blocks it, and focus leaving it closes
 *  its mention list. */
export function useSlotWidget<W>(widget: W | undefined): W | undefined {
  const { phase } = useDiffPaneHold();
  const [kept, setKept] = useState(widget);
  const next = slotWidget(phase, widget, kept);
  if (next.keep !== kept) setKept(next.keep);
  return next.render;
}

/** A slot child's last `value` read for its file (`entity` + `path`), which
 *  only a held slot of that same file gets back (`heldRetained`): for a value
 *  that only the shown slot's read supplies. */
export function useSlotRetained<T>(
  entity: string,
  path: string,
  value: T | undefined,
): T | undefined {
  const { phase } = useDiffPaneHold();
  const stamped = useMemo(
    () => (value === undefined ? undefined : { entity, path, value }),
    [entity, path, value],
  );
  const [kept, setKept] = useState(stamped);
  if (stamped !== undefined && stamped !== kept) setKept(stamped);
  return heldRetained(phase, { entity, path }, kept);
}
