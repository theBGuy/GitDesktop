import {
  type DragEvent,
  type ReactNode,
  type SyntheticEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { BoardItem } from "@/lib/git/types";
import { vetoSideButtonNavigation } from "@/lib/hotkeys/side-buttons";
import { useUiStore } from "@/lib/stores/ui";
import {
  type BoardColumnModel,
  MOVE_CANCELLED_ANNOUNCEMENT,
  movedAnnouncement,
  TRUNCATED_ORDER_REASON,
} from "../board-model";
import { dropAnchor, planDrop, plannerCards } from "../board-positioning";
import { BoardDragGhostFade, type GhostRect } from "./BoardDragGhost";
import {
  classifyDrop,
  DRAG_DOCUMENT_TOKENS,
  type DropVerdict,
  dropLanding,
  GHOST_FADE_MS,
  isCancelKey,
  recheckSlot,
  runCrossColumnDrop,
  slotAboveArchivedRun,
  slotIndexAt,
} from "./drag-model";
import type {
  BoardDragColumnHandle,
  BoardDragSeam,
  BoardDragTarget,
  DragPoint,
} from "./engine";
import { pointerEngine } from "./engine-pointer";
import {
  type BoardDragColumnRegistry,
  BoardDragColumnsContext,
  BoardDragGhostContext,
  type BoardDragHost,
  BoardDragSeamContext,
  BoardDragVisualsContext,
} from "./seam-context";
import { isTrustedEvent } from "./trusted-event";

/** The session as React state: a copy of the mirror that drives visuals only. */
interface SessionView {
  handle: { itemId: string };
  signature: string;
  ghostItem: BoardItem;
}

/** The last stored hover: the target and its verdict's kind. */
interface VerdictView {
  target: BoardDragTarget | null;
  kind: DropVerdict["kind"];
}

/** The session's truth, read and written synchronously by the seam methods and
 *  the window handlers, never during render. */
interface Session {
  itemId: string;
  signature: string;
  abort: () => void;
  ghostItem: BoardItem;
  lastKey: string | null;
  /** The last hover's target as the engine hit it, before it is resolved. */
  lastHit: BoardDragTarget | null;
  /** The last point `targetAt` was asked about in this session, and its answer. */
  asked: { point: DragPoint; hit: BoardDragTarget | null } | null;
  listeners: AbortController;
}

/** The ghost fading out where its session ended. */
interface FadeView {
  item: BoardItem;
  rect: GhostRect;
}

/** A drop whose card the board still draws short of where it was dropped: a
 *  cross-column drop until the card is drawn in `columnId`, a same-column one
 *  until it follows `afterId` (null = the top). */
interface LandingView {
  itemId: string;
  signature: string;
  until: { columnId: string } | { afterId: string | null };
}

interface Located {
  column: BoardColumnModel;
  col: number;
  item: BoardItem;
}

type Plan =
  | { kind: "move"; afterId: string | null }
  | { kind: "noop" }
  | { kind: "held" };

const NO_PLAN: Plan = { kind: "noop" };

const ids = (items: readonly BoardItem[]) => items.map((item) => item.itemId);

function locate(host: BoardDragHost, itemId: string): Located | null {
  for (let col = 0; col < host.columns.length; col += 1) {
    const column = host.columns[col];
    const item = column.items.find((it) => it.itemId === itemId);
    if (item !== undefined) return { column, col, item };
  }
  return null;
}

/** The keyboard path's planner inputs, so a drop and a key press plan alike. */
function planFor(
  host: BoardDragHost,
  column: BoardColumnModel,
  movedId: string,
  beforeId: string | null,
  planner: typeof planDrop = planDrop,
): Plan {
  return planner({
    order: plannerCards(host.loaded, host.restoring),
    column: plannerCards(column.items, host.restoring),
    movedId,
    beforeId,
    truncated: host.truncated,
  });
}

/** The verdict from the LIVE host: the column drawing the card now decides
 *  same-column against cross-column, never the column it was lifted from. */
function verdictFor(
  host: BoardDragHost,
  at: Located,
  target: BoardDragTarget | null,
): DropVerdict {
  const column =
    target === null
      ? undefined
      : host.columns.find((c) => c.id === target.columnId);
  const movedId = at.item.itemId;
  const crossColumn = column !== undefined && column.id !== at.column.id;
  return classifyDrop({
    target,
    currentColumnId: at.column.id,
    movedId,
    targetItemIds: column === undefined ? null : ids(column.items),
    moveHeld: crossColumn ? host.moveHeld(at.item) : undefined,
    plan:
      column === undefined || target === null
        ? NO_PLAN
        : planFor(host, column, movedId, target.beforeId),
    truncatedReason: TRUNCATED_ORDER_REASON.card,
  });
}

/** The target as it can be written: a slot inside or under an archived run
 *  moves above the run, so the line, the plan and the landing all read it. */
function resolveTarget(
  host: BoardDragHost,
  target: BoardDragTarget | null,
): BoardDragTarget | null {
  if (target === null) return null;
  const column = host.columns.find((c) => c.id === target.columnId);
  if (column === undefined) return target;
  return {
    ...target,
    beforeId: slotAboveArchivedRun({
      column: plannerCards(column.items, host.restoring),
      beforeId: target.beforeId,
    }),
  };
}

/** The dropped card keeps its lifted look while the board it was dropped on
 *  still draws it short of its landing. A same-column landing is drawn once the
 *  card's nearest live card above is the anchor, as the reorder's splice draws
 *  it; an anchor the board no longer holds can never be drawn, so it lets go. */
function landingHeld(host: BoardDragHost, landing: LandingView): boolean {
  if (host.signature !== landing.signature) return false;
  const at = locate(host, landing.itemId);
  if (at === null) return false;
  const { until } = landing;
  if ("columnId" in until) return at.column.id !== until.columnId;
  const order = plannerCards(host.loaded, host.restoring);
  const idx = order.findIndex((card) => card.itemId === landing.itemId);
  const above =
    order.slice(0, idx).findLast((card) => !card.isArchived)?.itemId ?? null;
  if (above === until.afterId) return false;
  return (
    until.afterId === null ||
    order.some((card) => card.itemId === until.afterId)
  );
}

function hoverKey(target: BoardDragTarget | null, kind: string): string {
  return JSON.stringify([target?.columnId ?? null, target?.beforeId, kind]);
}

// The window losing focus, never an element blur seen on its way past the
// window (a window-target event's target is not a Node).
const isWindowBlur = (e: Event) => !(e.target instanceof Node);

/** Keys that only modify another, named by `key`: a modifier held through the
 *  drag reports its own flag on every event, so the flags can't tell. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface ControllerView {
  setSession: (session: SessionView | null) => void;
  setVerdict: (verdict: VerdictView | null) => void;
  setBlocked: (blocked: boolean) => void;
  setFade: (fade: FadeView | null) => void;
  setLanding: (landing: LandingView | null) => void;
}

/** Everything the seam does, outside React: created once per root. */
function createController(view: ControllerView) {
  let host: BoardDragHost | null = null;
  let wrapperEl: HTMLElement | null = null;
  let session: Session | null = null;
  let blocked: AbortController | null = null;
  let swallow: AbortController | null = null;
  let latch: AbortController | null = null;
  const handles = new Set<BoardDragColumnHandle>();
  let ghostNode: HTMLElement | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let landing: LandingView | null = null;

  const setLanding = (next: LandingView | null) => {
    landing = next;
    view.setLanding(next);
  };

  /** A sent write's cache patch draws the card a tick after the release, so the
   *  source card keeps its lifted look until then or the write's settle. */
  const holdLanding = (pending: Promise<unknown>, held: LandingView) => {
    setLanding(held);
    const release = () => {
      if (landing === held) setLanding(null);
    };
    void pending.then(release, release);
  };

  // An unmount removes the wrapper from the document; an <Activity> hide leaves
  // it there under display: none, so the last committed host stays live.
  const liveHost = () => (wrapperEl?.isConnected ? host : null);

  const endSession = (s: Session) => {
    s.listeners.abort();
    if (session === s) session = null;
    view.setSession(null);
    view.setVerdict(null);
  };

  /** Read before the session ends: an engine may hide its ghost once it is
   *  told the session is over. */
  const ghostRect = (): GhostRect | null => {
    if (ghostNode === null || !ghostNode.isConnected) return null;
    const { left, top, width, height } = ghostNode.getBoundingClientRect();
    return { left, top, width, height };
  };

  const clearFade = () => {
    if (fadeTimer === null) return;
    clearTimeout(fadeTimer);
    fadeTimer = null;
    view.setFade(null);
  };

  /** A drop or a cancel the user made: the ghost fades where it was. */
  const fadeOut = (s: Session, rect: GhostRect | null) => {
    clearFade();
    if (rect === null || prefersReducedMotion()) return;
    view.setFade({ item: s.ghostItem, rect });
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      view.setFade(null);
    }, GHOST_FADE_MS);
  };

  const endSilently = () => {
    const s = session;
    if (s === null) return;
    endSession(s);
    s.abort();
  };

  /** The mirror's session when it belongs to the board on screen; a stale one
   *  is ended silently and reads as none. */
  const liveSession = (): { s: Session; h: BoardDragHost } | null => {
    const s = session;
    if (s === null) return null;
    const h = liveHost();
    if (h === null || h.signature !== s.signature) {
      endSilently();
      return null;
    }
    return { s, h };
  };

  const armSwallow = () => {
    swallow?.abort();
    const ac = new AbortController();
    swallow = ac;
    const disarm = () => {
      ac.abort();
      if (swallow === ac) swallow = null;
    };
    const capture = { capture: true, signal: ac.signal };
    window.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        disarm();
      },
      capture,
    );
    // The click follows its mouseup in the same task, so one task later the
    // gesture has no click left to swallow. Primary button only: a right or
    // middle press that cancels the drag still leaves the left release's click.
    window.addEventListener(
      "mouseup",
      (e) => {
        if (e.button === 0) setTimeout(disarm, 0);
      },
      capture,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        if (e.button === 0) disarm();
      },
      capture,
    );
    window.addEventListener(
      "blur",
      (e) => {
        if (isWindowBlur(e)) disarm();
      },
      { signal: ac.signal },
    );
  };

  const armContextMenuLatch = (armedBy: Event) => {
    latch?.abort();
    const ac = new AbortController();
    latch = ac;
    const disarm = () => {
      ac.abort();
      if (latch === ac) latch = null;
    };
    const capture = { capture: true, signal: ac.signal };
    window.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        disarm();
      },
      capture,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        if (e !== armedBy) disarm();
      },
      capture,
    );
    // Windows fires contextmenu on the right button's release, which never
    // arrives off the window; a key press comes before a keyboard-made one. A
    // modifier, or the auto-repeat of a key held through the drag, is not it.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!isTrustedEvent(e) || e.repeat || MODIFIER_KEYS.has(e.key)) return;
        disarm();
      },
      capture,
    );
    window.addEventListener(
      "blur",
      (e) => {
        if (isWindowBlur(e)) disarm();
      },
      { signal: ac.signal },
    );
  };

  const enterBlocked = () => {
    blocked?.abort();
    const ac = new AbortController();
    blocked = ac;
    view.setBlocked(true);
    const release = () => {
      ac.abort();
      if (blocked !== ac) return;
      blocked = null;
      view.setBlocked(false);
    };
    const capture = { capture: true, signal: ac.signal };
    window.addEventListener("mouseup", release, capture);
    window.addEventListener("pointerup", release, capture);
    window.addEventListener(
      "blur",
      (e) => {
        if (isWindowBlur(e)) release();
      },
      { signal: ac.signal },
    );
  };

  /** Esc, a non-primary press or the window losing focus: the seam takes the
   *  gesture back from the engine. */
  const windowCancel = (s: Session, press: MouseEvent | null) => {
    if (session !== s) return;
    const live = liveSession();
    if (live === null) return;
    // A side-button press spent on the cancel must not also navigate on release.
    if (press !== null) vetoSideButtonNavigation(press);
    const rect = ghostRect();
    endSession(s);
    s.abort();
    if (press?.button === 2) armContextMenuLatch(press);
    live.h.announce(MOVE_CANCELLED_ANNOUNCEMENT);
    fadeOut(s, rect);
  };

  // Added synchronously inside lift(), so a release in the same task as the
  // lift already finds them; one abort removes the set at session end.
  const installSessionListeners = (s: Session) => {
    const capture = { capture: true, signal: s.listeners.signal };
    window.addEventListener(
      "keydown",
      (e) => {
        if (!isCancelKey({ key: e.key, trusted: isTrustedEvent(e) })) return;
        e.preventDefault();
        e.stopPropagation();
        windowCancel(s, null);
      },
      capture,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) windowCancel(s, e);
      },
      capture,
    );
    window.addEventListener(
      "blur",
      (e) => {
        if (isWindowBlur(e)) windowCancel(s, null);
      },
      { signal: s.listeners.signal },
    );
  };

  /** A slotted drop re-plans with `dropAnchor`: its status write already draws
   *  the card at the slot, which `planDrop` would read as nothing to write. */
  const recheckLive = (
    pinned: Parameters<typeof recheckSlot>[0]["pinned"],
    beforeId: string | null,
    slotted: boolean,
  ) => {
    const live = liveHost();
    return recheckSlot({
      pinned,
      liveRepo: useUiStore.getState().repoPath,
      live:
        live === null
          ? null
          : {
              signature: live.signature,
              columns: live.columns.map((c) => ({
                id: c.id,
                itemIds: ids(c.items),
              })),
            },
      replan: () => {
        const column = live?.columns.find(
          (c) => c.id === pinned.targetColumnId,
        );
        if (live === null || column === undefined) return NO_PLAN;
        return planFor(
          live,
          column,
          pinned.movedId,
          beforeId,
          slotted ? dropAnchor : planDrop,
        );
      },
    });
  };

  /** Status first, then a slot re-planned on the live board once it settled.
   *  A drop-time `move` plan rides the status write as its slot, so the card
   *  is drawn there from the drop. The slot write goes through the DROP-time
   *  host, which carries the repo, project and lens the drop was made under. */
  const crossColumnDrop = (
    h: BoardDragHost,
    at: Located,
    target: BoardDragTarget,
    column: BoardColumnModel,
    afterId: string | null | undefined,
  ) => {
    const slotted = afterId !== undefined;
    const pending = h.writeStatus(
      at.item,
      column.id,
      slotted ? { afterId } : undefined,
    );
    if (pending === null) return;
    const movedId = at.item.itemId;
    holdLanding(pending, {
      itemId: movedId,
      signature: h.signature,
      until: { columnId: column.id },
    });
    const landingAt = dropLanding({
      order: ids(h.loaded),
      column: ids(column.items),
      movedId,
      afterId,
    });
    h.announce(
      movedAnnouncement(landingAt.idx + 1, landingAt.count, column.label),
    );
    const pinned = {
      repo: h.repo,
      signature: h.signature,
      movedId,
      targetColumnId: column.id,
    };
    void runCrossColumnDrop({
      writeStatus: () => pending,
      recheck: () => recheckLive(pinned, target.beforeId, slotted),
      writeSlot: (slotAfterId) => {
        const live = liveHost();
        const item = live === null ? undefined : locate(live, movedId)?.item;
        if (item === undefined) return;
        // The reorder hook reports its own failure.
        h.writePosition(item, slotAfterId)?.catch(() => undefined);
      },
    });
  };

  const hitTest = (pointer: DragPoint): BoardDragTarget | null => {
    const board = seam.boardScrollEl();
    if (board === null) return null;
    const outer = board.getBoundingClientRect();
    if (
      pointer.x < outer.left ||
      pointer.x >= outer.right ||
      pointer.y < outer.top ||
      pointer.y >= outer.bottom
    )
      return null;
    for (const handle of seam.columns()) {
      const { scrollEl } = handle;
      const rect = scrollEl.getBoundingClientRect();
      if (pointer.x < rect.left || pointer.x >= rect.right) continue;
      const contentY =
        Math.min(Math.max(pointer.y - rect.top, 0), scrollEl.clientHeight) +
        scrollEl.scrollTop;
      const k = slotIndexAt(contentY, handle.itemIds.length, handle.rowAt);
      return {
        columnId: handle.columnId,
        beforeId: handle.itemIds[k] ?? null,
      };
    }
    return null;
  };

  const seam: BoardDragSeam = {
    columns() {
      const h = host;
      if (h === null) return [];
      const order = new Map(h.columns.map((c, i) => [c.id, i]));
      return [...handles]
        .filter((handle) => order.has(handle.columnId))
        .sort(
          (a, b) => (order.get(a.columnId) ?? 0) - (order.get(b.columnId) ?? 0),
        );
    },
    boardScrollEl() {
      if (!wrapperEl?.isConnected) return null;
      return wrapperEl.querySelector<HTMLElement>(
        '[data-board-layout="board"]',
      );
    },
    targetAt(pointer: DragPoint) {
      const hit = hitTest(pointer);
      if (session !== null) session.asked = { point: pointer, hit };
      return hit;
    },
    lift({ itemId, pointer, abort }) {
      if (liveSession() !== null) return false;
      const h = liveHost();
      if (h === null) return false;
      const at = locate(h, itemId);
      if (at === null || at.item.content.kind === "redacted") return false;
      const held = h.repositionHeld(at.item);
      if (held !== undefined) {
        h.refuse(held);
        enterBlocked();
        armSwallow();
        return false;
      }
      clearFade();
      const s: Session = {
        itemId,
        signature: h.signature,
        abort,
        ghostItem: at.item,
        lastKey: null,
        lastHit: null,
        asked: null,
        listeners: new AbortController(),
      };
      session = s;
      installSessionListeners(s);
      armSwallow();
      view.setSession({
        handle: { itemId },
        signature: h.signature,
        ghostItem: at.item,
      });
      seam.hover(seam.targetAt(pointer));
      return true;
    },
    hover(hit) {
      const live = liveSession();
      if (live === null) return;
      live.s.lastHit = hit;
      const at = locate(live.h, live.s.itemId);
      if (at === null) {
        endSilently();
        return;
      }
      const target = resolveTarget(live.h, hit);
      const { kind } = verdictFor(live.h, at, target);
      const key = hoverKey(target, kind);
      if (key === live.s.lastKey) return;
      live.s.lastKey = key;
      view.setVerdict({ target, kind });
    },
    drop(hit) {
      const live = liveSession();
      if (live === null) return;
      const { s, h } = live;
      const rect = ghostRect();
      endSession(s);
      const at = locate(h, s.itemId);
      if (at === null) return;
      fadeOut(s, rect);
      const target = resolveTarget(h, hit);
      const verdict = verdictFor(h, at, target);
      if (verdict.kind === "outside") {
        h.announce(MOVE_CANCELLED_ANNOUNCEMENT);
        return;
      }
      if (verdict.kind === "own-slot") return;
      if (verdict.kind === "refused") {
        h.refuse(verdict.reason);
        return;
      }
      // A card archived or written to since the lift stops here.
      const held = h.repositionHeld(at.item);
      const column = h.columns.find((c) => c.id === target?.columnId);
      if (held !== undefined || target === null || column === undefined) {
        if (held !== undefined) h.refuse(held);
        return;
      }
      if (verdict.crossColumn) {
        crossColumnDrop(h, at, target, column, verdict.afterId);
        return;
      }
      if (verdict.afterId === undefined) return;
      const pending = h.writePosition(at.item, verdict.afterId);
      if (pending !== null)
        holdLanding(pending, {
          itemId: at.item.itemId,
          signature: h.signature,
          until: { afterId: verdict.afterId },
        });
      const landingAt = dropLanding({
        order: ids(h.loaded),
        column: ids(column.items),
        movedId: at.item.itemId,
        afterId: verdict.afterId,
      });
      h.landCursor(at.item.itemId, at.col, landingAt.idx);
      h.announce(
        movedAnnouncement(landingAt.idx + 1, landingAt.count, column.label),
      );
    },
    cancel() {
      const live = liveSession();
      if (live === null) return;
      const rect = ghostRect();
      endSession(live.s);
      live.h.announce(MOVE_CANCELLED_ANNOUNCEMENT);
      fadeOut(live.s, rect);
    },
  };

  const register: BoardDragColumnRegistry = (handle) => {
    handles.add(handle);
    return () => {
      handles.delete(handle);
    };
  };

  return {
    seam,
    register,
    setGhostNode(node: HTMLElement | null) {
      ghostNode = node;
    },
    commit(next: BoardDragHost, el: HTMLElement | null) {
      host = next;
      if (el !== null) wrapperEl = el;
    },
    /** A session whose board changed or whose card no column draws ends
     *  silently. A live one re-hit-tests the point its last hover came from,
     *  since a new host can move the rows or change the verdict under a still
     *  pointer (the hover's key dedupe ends the loop); a hover the seam can't tie
     *  to a point is replayed as it was. A landing ends once the board draws the
     *  card where it was dropped, or no longer can. */
    revalidate() {
      const s = session;
      if (s !== null) {
        const { asked } = s;
        seam.hover(
          asked !== null && asked.hit === s.lastHit
            ? seam.targetAt(asked.point)
            : s.lastHit,
        );
      }
      const l = landing;
      if (l !== null && host !== null && !landingHeld(host, l))
        setLanding(null);
    },
    /** Unmount or `<Activity>` hide: a cancel the seam owns, announced through
     *  the last COMMITTED host, since an unmount has already disconnected the
     *  wrapper. A session that host no longer draws ends silently. No ghost
     *  fades: the board it would fade over is gone. */
    teardown() {
      const s = session;
      const h = host;
      if (s !== null) {
        endSession(s);
        s.abort();
        if (h?.signature === s.signature && locate(h, s.itemId) !== null)
          h.announce(MOVE_CANCELLED_ANNOUNCEMENT);
      }
      clearFade();
      if (landing !== null) setLanding(null);
      blocked?.abort();
      blocked = null;
      view.setBlocked(false);
      swallow?.abort();
      swallow = null;
      latch?.abort();
      latch = null;
    },
  };
}

// React bubbles a portalled child's events through its React parent, so a
// popover a card renders elsewhere in the DOM must not reach the card's drag.
const landedInside = (e: SyntheticEvent<HTMLElement>) =>
  e.target instanceof Node && e.currentTarget.contains(e.target);

const preventDragStart = (e: DragEvent<HTMLElement>) => {
  if (landedInside(e)) e.preventDefault();
};

/**
 * The board layout's drag root: wraps its children in one `display: contents`
 * element carrying the drag state, then the seam contexts, then the engine's
 * Provider. It also owns the fading ghost and the document's cursor tokens.
 */
export function BoardDragRoot({
  host,
  children,
}: {
  host: BoardDragHost;
  children: ReactNode;
}) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [verdict, setVerdict] = useState<VerdictView | null>(null);
  const [blockedPress, setBlockedPress] = useState(false);
  const [fade, setFade] = useState<FadeView | null>(null);
  const [landing, setLanding] = useState<LandingView | null>(null);
  const [controller] = useState(() =>
    createController({
      setSession,
      setVerdict,
      setBlocked: setBlockedPress,
      setFade,
      setLanding,
    }),
  );
  const wrapperRef = useRef<HTMLDivElement>(null);
  // The live host the seam reads in events: every commit's, never a render's.
  useLayoutEffect(() => {
    controller.commit(host, wrapperRef.current);
  });
  // Every commit: a new host or session may have left the card undrawn.
  useEffect(() => {
    controller.revalidate();
  });
  useEffect(() => () => controller.teardown(), [controller]);

  // A session this render can't draw (another board, or a card no column
  // draws) is absent now; the effect above ends it.
  const live =
    session !== null &&
    session.signature === host.signature &&
    locate(host, session.handle.itemId) !== null
      ? session
      : null;
  const refused = live !== null && verdict?.kind === "refused";
  let dragState: "lifted" | "blocked" | undefined;
  if (blockedPress || refused) dragState = "blocked";
  else if (live !== null) dragState = "lifted";
  const landingId =
    landing !== null && landingHeld(host, landing) ? landing.itemId : null;
  const visuals = {
    sourceId: live?.handle.itemId ?? landingId,
    line:
      live !== null && verdict?.kind === "valid" && verdict.target !== null
        ? verdict.target
        : null,
  };
  const ghost =
    live === null
      ? null
      : { item: live.ghostItem, card: host.card, ref: controller.setGhostNode };
  // On the document, so the cursor holds outside the board too. Only tokens it
  // added come off, so a class the document already carried survives.
  useLayoutEffect(() => {
    if (dragState === undefined) return;
    const root = document.documentElement;
    const added = DRAG_DOCUMENT_TOKENS[dragState].filter(
      (token) => !root.classList.contains(token),
    );
    root.classList.add(...added);
    return () => root.classList.remove(...added);
  }, [dragState]);
  const Provider = pointerEngine.Provider;

  return (
    <div
      ref={wrapperRef}
      className="contents"
      data-board-drag-engine={pointerEngine.marker}
      data-board-drag={dragState}
      onDragStartCapture={preventDragStart}
    >
      <BoardDragSeamContext.Provider value={controller.seam}>
        <BoardDragColumnsContext.Provider value={controller.register}>
          <BoardDragVisualsContext.Provider value={visuals}>
            <BoardDragGhostContext.Provider value={ghost}>
              <Provider>{children}</Provider>
            </BoardDragGhostContext.Provider>
          </BoardDragVisualsContext.Provider>
        </BoardDragColumnsContext.Provider>
      </BoardDragSeamContext.Provider>
      {fade !== null &&
        createPortal(
          <BoardDragGhostFade
            item={fade.item}
            card={host.card}
            rect={fade.rect}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * The element the engine binds one card to. Its box is the card's box; it adds
 * no role beyond presentation, no tab stop and no aria. Gated here, so no engine
 * can lift a card from a press inside one of its portalled popovers.
 */
export function BoardDragCardSlot({
  itemId,
  disabled,
  children,
}: {
  itemId: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const bind = pointerEngine.useCard({ itemId, disabled });
  const press = bind.onPointerDown;
  const source = useContext(BoardDragVisualsContext)?.sourceId === itemId;
  return (
    <div
      role="presentation"
      ref={bind.ref}
      onPointerDown={
        press === undefined
          ? undefined
          : (e) => {
              if (landedInside(e)) press(e);
            }
      }
      data-board-drag-source={source ? "" : undefined}
      className={source ? "opacity-40" : undefined}
    >
      {children}
    </div>
  );
}

/** The insertion line at content offset `y` (its centre), drawn inside a
 *  `relative` box: 2 px in the ring token with a 6 px cap at its left end, so
 *  the slot reads by shape as well as colour. */
export function BoardDropLine({ y }: { y: number }) {
  return (
    <div
      aria-hidden
      data-board-drop-line=""
      className="pointer-events-none absolute inset-x-1.5 h-0.5 bg-ring"
      style={{ top: y - 1 }}
    >
      <span className="absolute top-1/2 -left-0.5 size-1.5 -translate-y-1/2 rounded-full bg-ring" />
    </div>
  );
}
