import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  Profiler,
  type ReactNode,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BoardColumnModel,
  MOVE_CANCELLED_ANNOUNCEMENT,
  TRUNCATED_ORDER_REASON,
} from "@/features/projects/board-model";
import { planDrop, plannerCards } from "@/features/projects/board-positioning";
import {
  BoardDragCardSlot,
  BoardDragRoot,
  BoardDropLine,
} from "@/features/projects/drag/BoardDragRoot";
import {
  DRAG_DOCUMENT_TOKENS,
  GHOST_FADE_MS,
  slotLineY,
} from "@/features/projects/drag/drag-model";
import type {
  BoardDragSeam,
  BoardDragTarget,
} from "@/features/projects/drag/engine";
import type { BoardDragHost } from "@/features/projects/drag/seam-context";
import {
  BOARD_DROP_TARGET_MOTION,
  useBoardDragColumn,
} from "@/features/projects/drag/use-board-drag-column";
import { TabPanel } from "@/features/repository/TabPanel";
import type { BoardItem } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useSideButtonNavigation } from "@/lib/hotkeys/side-buttons";
import { useUiStore } from "@/lib/stores/ui";

// The fake engine obeys E1-E10 by doing nothing on its own: each test drives the
// seam it captured, exactly as an engine would from its pointer stream.
// `cleanupCancel` makes the fake report a cancel from its own layout or passive
// cleanup, as an engine breaking E9 would.
const fake = vi.hoisted(() => ({
  seam: null as BoardDragSeam | null,
  cleanupCancel: null as "layout" | "passive" | null,
  /** Every press the slot forwarded to the engine, by card. */
  presses: [] as string[],
}));

// jsdom marks every dispatched event untrusted, so the seam's trust check is
// stood in for here and each test says whether its key came from the user.
const trust = vi.hoisted(() => ({ trusted: true }));

vi.mock("@/features/projects/drag/trusted-event", () => ({
  isTrustedEvent: () => trust.trusted,
}));

vi.mock("@/features/projects/drag/engine-pointer", async () => {
  const { useBoardDragSeam } = await import(
    "@/features/projects/drag/seam-context"
  );
  const { BoardDragGhost } = await import(
    "@/features/projects/drag/BoardDragGhost"
  );
  function Probe() {
    const seam = useBoardDragSeam();
    useLayoutEffect(() => {
      fake.seam = seam;
      return () => {
        if (fake.cleanupCancel === "layout") seam.cancel();
      };
    }, [seam]);
    useEffect(
      () => () => {
        if (fake.cleanupCancel === "passive") seam.cancel();
      },
      [seam],
    );
    return null;
  }
  return {
    pointerEngine: {
      marker: "gd-board-drag-engine-test",
      Provider: ({ children }: { children: ReactNode }) => (
        <>
          <Probe />
          <div data-testid="ghost-box">
            <BoardDragGhost />
          </div>
          {children}
        </>
      ),
      useCard: ({ itemId }: { itemId: string }) => ({
        ref: () => undefined,
        onPointerDown: () => {
          fake.presses.push(itemId);
        },
      }),
    },
  };
});

function pressEscape(target: Element, isTrusted = true) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  trust.trusted = isTrusted;
  try {
    target.dispatchEvent(event);
  } finally {
    trust.trusted = true;
  }
  return event;
}

const REPO = "C:/repos/board";
const HELD_REASON = "Finishing your last card change…";
const ARCHIVED_REASON = "Restore this card to change it";
const MOVE_HELD_REASON = "This board has no writable grouping";
const ROW = 40;

function item(
  id: string,
  extra: { archived?: boolean; redacted?: boolean } = {},
): BoardItem {
  return {
    itemId: id,
    isArchived: extra.archived ?? false,
    content: extra.redacted
      ? { kind: "redacted" }
      : {
          kind: "issue",
          id: `I_${id}`,
          number: id.length,
          title: `Card ${id}`,
          state: "OPEN",
          stateReason: null,
          repoNameWithOwner: "o/r",
          assignees: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          viewerCanSetFields: false,
        },
    fieldValues: [],
    addedAt: "2026-01-01T00:00:00Z",
  };
}

const LABELS: Record<string, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

interface Deferred {
  promise: Promise<unknown>;
  resolve: () => void;
  reject: () => void;
}

function deferred(): Deferred {
  let resolve = () => undefined as void;
  let reject = () => undefined as void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = () => res(undefined);
    reject = () => rej(new Error("status write failed"));
  });
  return { promise, resolve, reject };
}

interface HostSpec {
  /** The loaded order, archived cards included. */
  order: BoardItem[];
  /** Which column draws each id; ids missing here are drawn nowhere. */
  place: Record<string, keyof typeof LABELS>;
  signature?: string;
  truncated?: boolean;
  moveHeld?: string;
  heldIds?: string[];
  /** Cards with a restore in flight. */
  restoring?: string[];
  status?: Deferred | null;
  /** What writePosition returns; by default null, a write that sent nothing. */
  position?: Deferred | null;
}

function makeHost(spec: HostSpec) {
  const columns: BoardColumnModel[] = Object.keys(LABELS).map((id) => ({
    id,
    label: LABELS[id],
    color: null,
    items: spec.order.filter((it) => spec.place[it.itemId] === id),
  }));
  const host = {
    repo: REPO,
    signature: spec.signature ?? "board-1",
    columns,
    loaded: spec.order,
    restoring: new Set<string>(spec.restoring),
    truncated: spec.truncated ?? false,
    repositionHeld: vi.fn((it: BoardItem) => {
      if (it.isArchived) return ARCHIVED_REASON;
      return spec.heldIds?.includes(it.itemId) ? HELD_REASON : undefined;
    }),
    moveHeld: vi.fn((_it: BoardItem) => spec.moveHeld),
    writeStatus: vi.fn(
      (
        _it: BoardItem,
        _col: string,
        _slot: { afterId: string | null } | undefined,
      ) =>
        spec.status === undefined
          ? Promise.resolve()
          : (spec.status?.promise ?? null),
    ),
    writePosition: vi.fn(
      (_it: BoardItem, _afterId: string | null) =>
        spec.position?.promise ?? null,
    ),
    landCursor: vi.fn(),
    refuse: vi.fn(),
    announce: vi.fn(),
    card: { repoSlug: "o/r", ghHost: null, chipFields: [] },
  } satisfies BoardDragHost;
  return host;
}

// Global order interleaves the columns: a1 and a2 are adjacent in "To do" with
// b1 between them in the project order. h1 is held, r1 redacted, a3 is To do's
// last live card, and Done is empty.
const BASE_ORDER = () => [
  item("a1"),
  item("b1"),
  item("a2"),
  item("h1"),
  item("r1", { redacted: true }),
  item("b2"),
  item("a3"),
];
const BASE_PLACE: HostSpec["place"] = {
  a1: "todo",
  a2: "todo",
  a3: "todo",
  b1: "doing",
  h1: "doing",
  r1: "doing",
  b2: "doing",
};

function baseHost(extra: Partial<HostSpec> = {}) {
  return makeHost({
    order: BASE_ORDER(),
    place: BASE_PLACE,
    heldIds: ["h1"],
    ...extra,
  });
}

const rowAt = (index: number) => ({ start: index * ROW, size: ROW });

function TestColumn({
  column,
  hiddenSlot,
  onCardClick,
}: {
  column: BoardColumnModel;
  hiddenSlot: string | null;
  onCardClick: (id: string) => void;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const itemIds = useMemo(() => column.items.map((it) => it.itemId), [column]);
  const { tinted, lineIndex } = useBoardDragColumn({
    columnId: column.id,
    scrollEl,
    itemIds,
    rowAt,
  });
  return (
    <section
      data-testid={`col-${column.id}`}
      data-board-drop-target={tinted ? "" : undefined}
      className={BOARD_DROP_TARGET_MOTION.className}
      style={BOARD_DROP_TARGET_MOTION.style}
    >
      <div ref={setScrollEl} className="relative">
        {lineIndex !== null && (
          <BoardDropLine y={slotLineY(lineIndex, itemIds.length, rowAt)} />
        )}
        {column.items
          .filter((it) => it.itemId !== hiddenSlot)
          .map((it) => (
            <BoardDragCardSlot
              key={it.itemId}
              itemId={it.itemId}
              disabled={it.content.kind === "redacted"}
            >
              <button
                type="button"
                data-testid={`card-${it.itemId}`}
                onClick={() => onCardClick(it.itemId)}
              >
                {it.itemId}
              </button>
            </BoardDragCardSlot>
          ))}
      </div>
    </section>
  );
}

/** Called from a layout effect in the commit that renders each new host, so a
 *  test reads the DOM before any passive effect can change it. */
let onHostCommit: ((host: BoardDragHost) => void) | null = null;

function HostCommitProbe({ host }: { host: BoardDragHost }) {
  useLayoutEffect(() => {
    onHostCommit?.(host);
  }, [host]);
  return null;
}

const ancestorKeyDown = vi.fn();
const ancestorContextMenu = vi.fn();
const cardClick = vi.fn();

function Board({
  host,
  hiddenSlot = null,
}: {
  host: BoardDragHost;
  hiddenSlot?: string | null;
}) {
  return (
    <BoardDragRoot host={host}>
      <HostCommitProbe host={host} />
      <div
        data-board-layout="board"
        onKeyDown={(e) => ancestorKeyDown(e.key)}
        onContextMenu={() => ancestorContextMenu()}
      >
        {host.columns.map((column) => (
          <TestColumn
            key={column.id}
            column={column}
            hiddenSlot={hiddenSlot}
            onCardClick={cardClick}
          />
        ))}
      </div>
    </BoardDragRoot>
  );
}

function Shell({
  host,
  mode = "visible",
  hiddenSlot = null,
  mounted = true,
}: {
  host: BoardDragHost;
  mode?: "visible" | "hidden";
  hiddenSlot?: string | null;
  mounted?: boolean;
}) {
  return (
    <TabPanel active={mode === "visible"}>
      {mounted && <Board host={host} hiddenSlot={hiddenSlot} />}
    </TabPanel>
  );
}

function seam(): BoardDragSeam {
  if (fake.seam === null) throw new Error("the fake engine captured no seam");
  return fake.seam;
}

const wrapper = () =>
  document.querySelector<HTMLElement>("[data-board-drag-engine]");
const dragState = () => wrapper()?.getAttribute("data-board-drag") ?? null;
const ghostBox = () => screen.getByTestId("ghost-box");
const lines = () => document.querySelectorAll("[data-board-drop-line]");

function lift(itemId: string, abort = vi.fn()) {
  let started = false;
  act(() => {
    started = seam().lift({ itemId, pointer: { x: -1, y: -1 }, abort });
  });
  return { started, abort };
}

const act$ = (fn: () => void) => act(fn);
const hover = (target: BoardDragTarget | null) =>
  act$(() => seam().hover(target));
const drop = (target: BoardDragTarget | null) =>
  act$(() => seam().drop(target));

let bubbleKeys: string[] = [];
const onWindowKey = (e: KeyboardEvent) => bubbleKeys.push(e.key);

beforeEach(() => {
  fake.seam = null;
  fake.cleanupCancel = null;
  fake.presses = [];
  onHostCommit = null;
  trust.trusted = true;
  bubbleKeys = [];
  ancestorKeyDown.mockClear();
  ancestorContextMenu.mockClear();
  cardClick.mockClear();
  useUiStore.setState({ repoPath: REPO });
  window.addEventListener("keydown", onWindowKey);
});

afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
});

describe("lift (AC3, AC4)", () => {
  it("refuses a redacted or unknown card silently", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    expect(lift("r1").started).toBe(false);
    expect(lift("nope").started).toBe(false);
    expect(host.refuse).not.toHaveBeenCalled();
    expect(dragState()).toBeNull();
  });

  it("refuses a held card once, blocks until mouseup, and adds nothing at the release", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    expect(lift("h1").started).toBe(false);
    expect(host.refuse).toHaveBeenCalledTimes(1);
    expect(host.refuse).toHaveBeenCalledWith(HELD_REASON);
    expect(dragState()).toBe("blocked");
    act(() => {
      fireEvent.mouseUp(screen.getByTestId("card-h1"));
    });
    expect(dragState()).toBeNull();
    expect(host.refuse).toHaveBeenCalledTimes(1);
    expect(host.announce).not.toHaveBeenCalled();
  });

  it("lifts a free card: source dimmed, ghost from data, wrapper lifted", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    expect(lift("a1").started).toBe(true);
    const slot = screen.getByTestId("card-a1").parentElement;
    expect(slot).toHaveAttribute("data-board-drag-source");
    expect(within(ghostBox()).getByText("Card a1")).toBeInTheDocument();
    expect(dragState()).toBe("lifted");
  });

  it("refuses a second lift while the mirror holds a session, even in the same task", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    let first = false;
    let second = true;
    act(() => {
      first = seam().lift({
        itemId: "a1",
        pointer: { x: -1, y: -1 },
        abort: vi.fn(),
      });
      second = seam().lift({
        itemId: "a2",
        pointer: { x: -1, y: -1 },
        abort: vi.fn(),
      });
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("keeps drawing the ghost when the source slot is no longer rendered", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    view.rerender(<Shell host={host} hiddenSlot="a1" />);
    expect(screen.queryByTestId("card-a1")).toBeNull();
    expect(within(ghostBox()).getByText("Card a1")).toBeInTheDocument();
    expect(dragState()).toBe("lifted");
    hover({ columnId: "done", beforeId: null });
    expect(lines()).toHaveLength(1);
  });
});

/** One card whose slot also renders a popover portalled to the body, as a
 *  draft card's notes and an issue card's peek do. */
function PortalBoard({ host }: { host: BoardDragHost }) {
  return (
    <BoardDragRoot host={host}>
      <div data-board-layout="board">
        <BoardDragCardSlot itemId="a1" disabled={false}>
          <button type="button" data-testid="card-a1">
            a1
          </button>
          {createPortal(
            <div data-testid="popover">
              <a href="#notes" data-testid="popover-link">
                notes
              </a>
            </div>,
            document.body,
          )}
        </BoardDragCardSlot>
      </div>
    </BoardDragRoot>
  );
}

describe("what the drag adds to the accessibility tree", () => {
  /** The slot's attributes beyond its presentation role, its class and its
   *  data markers: none may be a role, a tab stop or an aria attribute. */
  function expectBareSlot(itemId: string) {
    const slot = screen.getByTestId(`card-${itemId}`).parentElement;
    expect(slot?.getAttribute("role")).toBe("presentation");
    expect(
      slot
        ?.getAttributeNames()
        .filter((n) => n !== "role" && n !== "class" && !n.startsWith("data-")),
    ).toEqual([]);
  }

  const liveRegions = () =>
    document.querySelectorAll(
      '[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]',
    );

  it("a card slot is role=presentation and nothing more at rest, lifted and landing", () => {
    const host = baseHost({ status: deferred() });
    render(<Shell host={host} />);
    expectBareSlot("a1");
    lift("a1");
    expect(liftedLook("a1")).toBe(true);
    expectBareSlot("a1");
    drop({ columnId: "doing", beforeId: "b2" });
    expect(liftedLook("a1")).toBe(true);
    expectBareSlot("a1");
  });

  it("no live region through a lift, hovers, a drop, a cancel and a refused lift", () => {
    vi.useFakeTimers();
    try {
      render(<Shell host={baseHost({ status: deferred() })} />);
      expect(liveRegions()).toHaveLength(0);
      lift("a1");
      expect(liveRegions()).toHaveLength(0);
      hover({ columnId: "doing", beforeId: "b2" });
      expect(liveRegions()).toHaveLength(0);
      hover({ columnId: "todo", beforeId: "a1" });
      expect(liveRegions()).toHaveLength(0);
      drop({ columnId: "doing", beforeId: "b2" });
      expect(fadingGhost()).not.toBeNull();
      expect(liveRegions()).toHaveLength(0);
      lift("a2");
      act(() => seam().cancel());
      expect(liveRegions()).toHaveLength(0);
      lift("h1");
      expect(dragState()).toBe("blocked");
      expect(liveRegions()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("slot containment", () => {
  it("forwards a press on the card but never one inside a portalled child", () => {
    render(<PortalBoard host={baseHost()} />);
    const reached = vi.fn();
    document.addEventListener("pointerdown", reached);
    try {
      expect(
        fireEvent.pointerDown(screen.getByTestId("popover-link"), {
          button: 0,
        }),
      ).toBe(true);
      expect(reached).toHaveBeenCalledTimes(1);
      expect(fake.presses).toEqual([]);
      fireEvent.pointerDown(screen.getByTestId("card-a1"), { button: 0 });
      expect(fake.presses).toEqual(["a1"]);
    } finally {
      document.removeEventListener("pointerdown", reached);
    }
  });

  it("cancels a native drag from the card but not one from a portalled child", () => {
    render(<PortalBoard host={baseHost()} />);
    expect(fireEvent.dragStart(screen.getByTestId("popover-link"))).toBe(true);
    expect(fireEvent.dragStart(screen.getByTestId("card-a1"))).toBe(false);
  });
});

describe("hover (AC5)", () => {
  it("draws the line and tint in another column's valid slot", () => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    const doing = screen.getByTestId("col-doing");
    expect(doing.querySelectorAll("[data-board-drop-line]")).toHaveLength(1);
    expect(doing).toHaveAttribute("data-board-drop-target");
    expect(lines()).toHaveLength(1);
  });

  it.each([
    ["the card itself", "a1"],
    [
      "its next card, with another column's card between in the global order",
      "a2",
    ],
  ])("draws nothing over its own slot: beforeId = %s", (_name, beforeId) => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    hover({ columnId: "todo", beforeId });
    expect(lines()).toHaveLength(0);
    expect(screen.getByTestId("col-todo")).not.toHaveAttribute(
      "data-board-drop-target",
    );
    expect(dragState()).toBe("lifted");
  });

  it("blocks the end of a column with another live card on a truncated board", () => {
    render(<Shell host={baseHost({ truncated: true })} />);
    lift("a1");
    hover({ columnId: "todo", beforeId: null });
    expect(lines()).toHaveLength(0);
    expect(dragState()).toBe("blocked");
  });

  it("blocks the end slot right under a column's last card on a truncated board", () => {
    render(<Shell host={baseHost({ truncated: true })} />);
    lift("a3");
    hover({ columnId: "todo", beforeId: null });
    expect(lines()).toHaveLength(0);
    expect(dragState()).toBe("blocked");
  });

  it.each([false, true])(
    "takes an empty column from another column (truncated %s)",
    (truncated) => {
      render(<Shell host={baseHost({ truncated })} />);
      lift("a1");
      hover({ columnId: "done", beforeId: null });
      const done = screen.getByTestId("col-done");
      expect(done.querySelectorAll("[data-board-drop-line]")).toHaveLength(1);
      expect(done).toHaveAttribute("data-board-drop-target");
      expect(dragState()).toBe("lifted");
    },
  );

  it("blocks another column while the move is held", () => {
    render(<Shell host={baseHost({ moveHeld: MOVE_HELD_REASON })} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    expect(lines()).toHaveLength(0);
    expect(screen.getByTestId("col-doing")).not.toHaveAttribute(
      "data-board-drop-target",
    );
    expect(dragState()).toBe("blocked");
  });

  it("draws nothing for a null target", () => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    hover(null);
    expect(lines()).toHaveLength(0);
  });

  it("follows the LIVE column after a refetch re-buckets the card", () => {
    const host = baseHost({ moveHeld: MOVE_HELD_REASON });
    const view = render(<Shell host={host} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    expect(dragState()).toBe("blocked");
    const moved = baseHost({
      moveHeld: MOVE_HELD_REASON,
      place: { ...BASE_PLACE, a1: "doing" },
    });
    view.rerender(<Shell host={moved} />);
    // Doing now draws the card: same column, no move hold consulted.
    hover({ columnId: "doing", beforeId: "b2" });
    expect(dragState()).toBe("lifted");
    expect(lines()).toHaveLength(1);
    // To do is now the other column, held.
    hover({ columnId: "todo", beforeId: "a2" });
    expect(dragState()).toBe("blocked");
  });
});

describe("a still pointer", () => {
  const doing = () => screen.getByTestId("col-doing");
  const tokensOn = (state: keyof typeof DRAG_DOCUMENT_TOKENS) =>
    DRAG_DOCUMENT_TOKENS[state].every((t) =>
      document.documentElement.classList.contains(t),
    );

  it("a host that lifts the move hold draws the line without a pointer move", () => {
    const view = render(
      <Shell host={baseHost({ moveHeld: MOVE_HELD_REASON })} />,
    );
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    expect(dragState()).toBe("blocked");
    expect(lines()).toHaveLength(0);
    view.rerender(<Shell host={baseHost()} />);
    expect(dragState()).toBe("lifted");
    expect(tokensOn("lifted")).toBe(true);
    expect(doing().querySelectorAll("[data-board-drop-line]")).toHaveLength(1);
    expect(doing()).toHaveAttribute("data-board-drop-target");
  });

  it("a host that starts a move hold clears the line without a pointer move", () => {
    const view = render(<Shell host={baseHost()} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    expect(dragState()).toBe("lifted");
    expect(lines()).toHaveLength(1);
    view.rerender(<Shell host={baseHost({ moveHeld: MOVE_HELD_REASON })} />);
    expect(dragState()).toBe("blocked");
    expect(tokensOn("blocked")).toBe(true);
    expect(lines()).toHaveLength(0);
    expect(doing()).not.toHaveAttribute("data-board-drop-target");
  });
});

/** A DOMRect from "left,top,width,height". */
function rectOf(spec: string | undefined): DOMRect {
  const [left, top, width, height] = (spec ?? "0,0,0,0").split(",").map(Number);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/** Gives `el` a rect for the prototype spy, and fixed scroll metrics. */
function place(
  el: Element | null,
  rect: string,
  scroll?: { clientHeight: number; scrollTop: number },
) {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to place");
  el.dataset.rect = rect;
  if (scroll === undefined) return;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: scroll.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    value: scroll.scrollTop,
  });
}

describe("targetAt geometry", () => {
  let rects: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return rectOf(this.dataset.rect);
      });
  });
  afterEach(() => {
    rects?.mockRestore();
  });

  // The board spans x [0, 900), y [0, 600). To do spans x [0, 280) and
  // y [100, 500) over 3 rows; Doing x [300, 580) and y [100, 200), a 100 px
  // viewport over 4 rows (row midpoints 20, 60, 100, 140); Done x [600, 1000)
  // runs past the board's right edge. Rows are 40 px.
  function layout(doingScrollTop = 0) {
    render(<Shell host={baseHost()} />);
    const scroller = (id: string) =>
      screen.getByTestId(`col-${id}`).firstElementChild;
    place(document.querySelector('[data-board-layout="board"]'), "0,0,900,600");
    place(scroller("todo"), "0,100,280,400", {
      clientHeight: 400,
      scrollTop: 0,
    });
    place(scroller("doing"), "300,100,280,100", {
      clientHeight: 100,
      scrollTop: doingScrollTop,
    });
    place(scroller("done"), "600,100,400,400", {
      clientHeight: 400,
      scrollTop: 0,
    });
  }

  const at = (x: number, y: number) => seam().targetAt({ x, y });

  it("a point in a scrolled column resolves to the row under it", () => {
    layout(60);
    // Content y 10 + 60 = 70: past b1's and h1's midpoints, before r1's.
    expect(at(400, 110)).toEqual({ columnId: "doing", beforeId: "r1" });
  });

  it("a point above a scrolled column's viewport is clamped to its top", () => {
    layout(60);
    // Content y 0 + 60, on h1's midpoint: the slot after it.
    expect(at(400, 50)).toEqual({ columnId: "doing", beforeId: "r1" });
  });

  it("a point below a column's viewport is clamped to its bottom", () => {
    layout();
    // Content y 100, on r1's midpoint and before b2's.
    expect(at(400, 300)).toEqual({ columnId: "doing", beforeId: "b2" });
  });

  it("a point above the first row is the first slot, one below the last row the end slot", () => {
    layout();
    expect(at(100, 105)).toEqual({ columnId: "todo", beforeId: "a1" });
    expect(at(100, 300)).toEqual({ columnId: "todo", beforeId: null });
    expect(at(100, 550)).toEqual({ columnId: "todo", beforeId: null });
  });

  it("a column's left edge is in it and its right edge is not", () => {
    layout();
    expect(at(279, 105)).toEqual({ columnId: "todo", beforeId: "a1" });
    expect(at(300, 105)).toEqual({ columnId: "doing", beforeId: "b1" });
    expect(at(280, 105)).toBeNull();
  });

  it("the gap between two columns and a point outside the board are no target", () => {
    layout();
    expect(at(290, 150)).toBeNull();
    expect(at(590, 150)).toBeNull();
    // Inside Done's box but past the board's right edge, and under the board.
    expect(at(950, 150)).toBeNull();
    expect(at(100, 650)).toBeNull();
    expect(at(-1, 150)).toBeNull();
  });
});

describe("a still pointer over rows that move", () => {
  let rects: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return rectOf(this.dataset.rect);
      });
  });
  afterEach(() => {
    rects?.mockRestore();
  });

  // The board spans x [0, 900) and y [0, 600), Doing's scroller x [300, 580)
  // and y [100, 500). The pointer rests at content y 50: past the first row's
  // midpoint and before the second's, so its slot is Doing's second.
  const POINTER = { x: 400, y: 150 };

  function placeAndLift() {
    place(document.querySelector('[data-board-layout="board"]'), "0,0,900,600");
    place(
      screen.getByTestId("col-doing").firstElementChild,
      "300,100,280,400",
      { clientHeight: 400, scrollTop: 0 },
    );
    act(() => {
      seam().lift({ itemId: "a1", pointer: POINTER, abort: vi.fn() });
    });
  }

  /** The line's slot index in Doing, read back from where it is drawn. */
  function doingLineIndex(count: number) {
    const line = screen
      .getByTestId("col-doing")
      .querySelector<HTMLElement>("[data-board-drop-line]");
    if (line === null) return null;
    const top = Number.parseFloat(line.style.top);
    for (let i = 0; i <= count; i += 1)
      if (slotLineY(i, count, rowAt) - 1 === top) return i;
    return -1;
  }

  const doingIds = (host: BoardDragHost) =>
    host.columns[1].items.map((it) => it.itemId);

  it("re-hit-tests the pointer when a card lands above it, and the release writes the slot the line showed", () => {
    const view = render(<Shell host={baseHost()} />);
    placeAndLift();
    expect(doingLineIndex(4)).toBe(doingIds(baseHost()).indexOf("h1"));
    const inserted = makeHost({
      order: [item("a1"), item("n0"), ...BASE_ORDER().slice(1)],
      place: { ...BASE_PLACE, n0: "doing" },
      heldIds: ["h1"],
      status: deferred(),
    });
    view.rerender(<Shell host={inserted} />);
    const slot = seam().targetAt(POINTER);
    expect(slot).toEqual({ columnId: "doing", beforeId: "b1" });
    expect(doingLineIndex(5)).toBe(doingIds(inserted).indexOf("b1"));
    drop(slot);
    // Before b1, a1 follows n0 in the project order.
    expect(inserted.writeStatus).toHaveBeenCalledWith(
      inserted.columns[0].items[0],
      "doing",
      { afterId: "n0" },
    );
  });

  it("keeps the column tinted with a line when the card the pointer rested before is removed", () => {
    const view = render(<Shell host={baseHost()} />);
    placeAndLift();
    const removed = makeHost({
      order: BASE_ORDER().filter((it) => it.itemId !== "h1"),
      place: BASE_PLACE,
      status: deferred(),
    });
    view.rerender(<Shell host={removed} />);
    const doing = screen.getByTestId("col-doing");
    expect(doing).toHaveAttribute("data-board-drop-target");
    expect(doingLineIndex(3)).toBe(doingIds(removed).indexOf("r1"));
    drop(seam().targetAt(POINTER));
    expect(removed.writeStatus).toHaveBeenCalledWith(
      removed.columns[0].items[0],
      "doing",
      { afterId: "a2" },
    );
  });

  it("an unchanged board under a still pointer changes no hover state and commits nothing", () => {
    const onRender = vi.fn();
    render(
      <Profiler id="board" onRender={onRender}>
        <Shell host={baseHost()} />
      </Profiler>,
    );
    placeAndLift();
    const commits = onRender.mock.calls.length;
    act(() => {
      for (let i = 0; i < 5; i += 1) seam().hover(seam().targetAt(POINTER));
    });
    expect(onRender).toHaveBeenCalledTimes(commits);
    expect(doingLineIndex(4)).toBe(1);
  });
});

describe("drop, same column (AC6, AC11)", () => {
  it("writes planDrop's anchor, lands the cursor and announces the landing", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: null });
    const a1 = host.columns[0].items[0];
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(a1, "a3");
    expect(host.landCursor).toHaveBeenCalledWith("a1", 0, 2);
    expect(host.announce).toHaveBeenCalledWith("Moved to 3 of 3 in To do");
    expect(host.writeStatus).not.toHaveBeenCalled();
    expect(dragState()).toBeNull();
  });

  it("does nothing at all on a release over its own slot", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: "a2" });
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.writeStatus).not.toHaveBeenCalled();
    expect(host.announce).not.toHaveBeenCalled();
    expect(host.refuse).not.toHaveBeenCalled();
  });
});

/** Drops a1 before b2 in Doing (drop-time anchor r1), then re-renders the
 *  status write's optimistic board: a1 drawn in Doing and a new card n1 right
 *  before b2, so the re-planned anchor is n1. */
function crossColumnScenario(extra: Partial<HostSpec> = {}) {
  const status = deferred();
  const host = baseHost({ status, ...extra });
  const view = render(<Shell host={host} />);
  lift("a1");
  drop({ columnId: "doing", beforeId: "b2" });
  const settled = makeHost({
    order: [
      item("b1"),
      item("a2"),
      item("h1"),
      item("a1"),
      item("r1", { redacted: true }),
      item("n1"),
      item("b2"),
      item("a3"),
    ],
    place: { ...BASE_PLACE, a1: "doing", n1: "doing" },
    heldIds: ["h1"],
  });
  return { status, host, settled, view };
}

const settle = async (d: Deferred, how: "resolve" | "reject" = "resolve") => {
  await act(async () => {
    d[how]();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("drop, cross column (AC7)", () => {
  it("cross-column drop: no position write while the status write is pending", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    expect(host.writeStatus).toHaveBeenCalledTimes(1);
    expect(host.writeStatus).toHaveBeenCalledWith(
      host.columns[0].items[0],
      "doing",
      { afterId: "r1" },
    );
    expect(host.announce).toHaveBeenCalledWith("Moved to 4 of 5 in Doing");
    expect(host.writePosition).not.toHaveBeenCalled();
    view.rerender(<Shell host={settled} />);
    expect(host.writePosition).not.toHaveBeenCalled();
    await settle(status);
    // The re-planned anchor, on the DROP-time host, with the live board's item.
    const liveA1 = settled.columns[1].items.find((it) => it.itemId === "a1");
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(liveA1, "n1");
    expect(settled.writePosition).not.toHaveBeenCalled();
  });

  it("announces nothing and writes nothing when writeStatus returns null", () => {
    const host = baseHost({ status: null });
    render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "doing", beforeId: "b2" });
    expect(host.writeStatus).toHaveBeenCalledTimes(1);
    expect(host.announce).not.toHaveBeenCalled();
    expect(host.writePosition).not.toHaveBeenCalled();
  });

  it("never writes the slot after a rejected status write", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    view.rerender(<Shell host={settled} />);
    await settle(status, "reject");
    expect(host.writePosition).not.toHaveBeenCalled();
  });

  it("a rejected slot write after the status settled leaves no unhandled rejection", async () => {
    const position = deferred();
    const { status, host, settled, view } = crossColumnScenario();
    // A vi.fn handles a returned promise itself to track its settle, so the
    // seam is handed the bare promise, as the reorder hook would hand it.
    const sent: (string | null)[] = [];
    Object.assign(host, {
      writePosition: (_it: BoardItem, afterId: string | null) => {
        sent.push(afterId);
        return position.promise;
      },
    });
    view.rerender(<Shell host={settled} />);
    await settle(status);
    expect(sent).toEqual(["n1"]);
    await settle(position, "reject");
  });

  it.each([false, true])(
    "an empty target column (truncated %s) writes the status only while the re-plan stays noop",
    async (truncated) => {
      const status = deferred();
      const host = baseHost({ status, truncated });
      render(<Shell host={host} />);
      lift("a1");
      drop({ columnId: "done", beforeId: null });
      expect(host.writeStatus).toHaveBeenCalledWith(
        host.columns[0].items[0],
        "done",
        undefined,
      );
      expect(host.refuse).not.toHaveBeenCalled();
      expect(host.announce).toHaveBeenCalledWith("Moved to 1 of 1 in Done");
      await settle(status);
      expect(host.writePosition).not.toHaveBeenCalled();
    },
  );

  it("writes the slot when the board changed so the re-plan is a move", async () => {
    const status = deferred();
    const host = baseHost({ status });
    const view = render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "done", beforeId: null });
    const settled = makeHost({
      order: [item("a1"), item("d1"), ...BASE_ORDER().slice(1)],
      place: { ...BASE_PLACE, a1: "done", d1: "done" },
      heldIds: ["h1"],
    });
    view.rerender(<Shell host={settled} />);
    await settle(status);
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(
      settled.columns[2].items[0],
      "d1",
    );
  });

  // b2's live predecessor once a1 leaves is r1, so a drop before b2 moves a1;
  // a1 already precedes b1 in the project order, so a drop before b1 does not.
  it.each([
    {
      slot: "before b2",
      beforeId: "b2",
      column: "doing",
      sent: { afterId: "r1" },
    },
    { slot: "before b1", beforeId: "b1", column: "doing", sent: undefined },
    {
      slot: "in the empty column",
      beforeId: null,
      column: "done",
      sent: undefined,
    },
  ])(
    "cross-column drop: the status write carries the dropped slot ($slot)",
    ({ beforeId, column, sent }) => {
      const host = baseHost({ status: deferred() });
      render(<Shell host={host} />);
      lift("a1");
      drop({ columnId: column, beforeId });
      expect(host.writeStatus).toHaveBeenCalledTimes(1);
      expect(host.writeStatus).toHaveBeenCalledWith(
        host.columns[0].items[0],
        column,
        sent,
      );
    },
  );

  it("cross-column drop: the slot is written although the board already draws the card there", async () => {
    const status = deferred();
    const host = baseHost({ status });
    const view = render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "doing", beforeId: "b2" });
    // The status write's optimistic board: a1 in Doing, spliced after r1.
    const patched = makeHost({
      order: [
        item("b1"),
        item("a2"),
        item("h1"),
        item("r1", { redacted: true }),
        item("a1"),
        item("b2"),
        item("a3"),
      ],
      place: { ...BASE_PLACE, a1: "doing" },
      heldIds: ["h1"],
    });
    view.rerender(<Shell host={patched} />);
    const doing = patched.columns[1];
    expect(
      planDrop({
        order: plannerCards(patched.loaded, patched.restoring),
        column: plannerCards(doing.items, patched.restoring),
        movedId: "a1",
        beforeId: "b2",
        truncated: false,
      }),
    ).toEqual({ kind: "noop" });
    await settle(status);
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(
      doing.items.find((it) => it.itemId === "a1"),
      "r1",
    );
  });
});

/** The lifted look the source slot shows: the dim and its marker together. */
function liftedLook(itemId: string) {
  const slot = screen.getByTestId(`card-${itemId}`).parentElement;
  const marked = slot?.hasAttribute("data-board-drag-source") ?? false;
  const dimmed = slot?.classList.contains("opacity-40") ?? false;
  expect(marked).toBe(dimmed);
  return marked;
}

const slotOf = (itemId: string) =>
  screen.getByTestId(`card-${itemId}`).parentElement;

/** Re-renders with `next`, watching the source marker: whether the card's
 *  slot carried it in the commit that rendered `next`, before any passive
 *  effect ran, and every marker mutation recorded on the slot it ends up in. */
function rerenderWatchingMarker(
  view: ReturnType<typeof render>,
  next: BoardDragHost,
  itemId = "a1",
) {
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, {
    subtree: true,
    attributeFilter: ["data-board-drag-source"],
    attributeOldValue: true,
  });
  let markedAtCommit: boolean | null = null;
  onHostCommit = (committed) => {
    if (committed === next && markedAtCommit === null)
      markedAtCommit =
        slotOf(itemId)?.hasAttribute("data-board-drag-source") ?? null;
  };
  try {
    view.rerender(<Shell host={next} />);
  } finally {
    onHostCommit = null;
  }
  const slot = slotOf(itemId);
  const onSlot = observer.takeRecords().filter((r) => r.target === slot);
  observer.disconnect();
  return { markedAtCommit, onSlot };
}

const columnOf = (itemId: string) =>
  screen.getByTestId(`card-${itemId}`).closest("section")?.dataset.testid;

describe("the source card after a cross-column drop", () => {
  it("keeps its lifted look until the board draws it in the target column", async () => {
    const { status, settled, view } = crossColumnScenario();
    expect(columnOf("a1")).toBe("col-todo");
    expect(liftedLook("a1")).toBe(true);
    // The session itself is over: no ghost, no line, no cursor.
    expect(dragState()).toBeNull();
    expect(within(ghostBox()).queryByText("Card a1")).toBeNull();
    expect(lines()).toHaveLength(0);
    // Never marked in its target, not even for the commit that drew it there.
    const { markedAtCommit, onSlot } = rerenderWatchingMarker(view, settled);
    expect(columnOf("a1")).toBe("col-doing");
    expect(markedAtCommit).toBe(false);
    expect(onSlot).toEqual([]);
    expect(liftedLook("a1")).toBe(false);
    // A rollback drawing it back at its source shows it plainly.
    view.rerender(<Shell host={baseHost()} />);
    expect(columnOf("a1")).toBe("col-todo");
    expect(liftedLook("a1")).toBe(false);
    await settle(status);
    expect(liftedLook("a1")).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "lets go at the status write's settle (%s) when the board never moved it",
    async (how) => {
      const { status } = crossColumnScenario();
      expect(liftedLook("a1")).toBe(true);
      await settle(status, how);
      expect(columnOf("a1")).toBe("col-todo");
      expect(liftedLook("a1")).toBe(false);
    },
  );

  // Both send no slot: a1 already precedes b1 in the project order, and Done
  // is empty. The patch then draws a1 in the target at its project-wide place.
  const UNSLOTTED = [
    ["before b1", "doing", "b1"],
    ["into the empty column", "done", null],
  ] as const;

  function unslottedDrop(columnId: string, beforeId: string | null) {
    const status = deferred();
    const host = baseHost({ status });
    const view = render(<Shell host={host} />);
    lift("a1");
    drop({ columnId, beforeId });
    expect(host.writeStatus).toHaveBeenCalledWith(
      host.columns[0].items[0],
      columnId,
      undefined,
    );
    const moved = baseHost({ place: { ...BASE_PLACE, a1: columnId } });
    return { status, view, moved };
  }

  it.each(UNSLOTTED)(
    "an unslotted drop (%s) keeps its lifted look until the board draws it in the target column",
    async (_name, columnId, beforeId) => {
      const { status, view, moved } = unslottedDrop(columnId, beforeId);
      expect(columnOf("a1")).toBe("col-todo");
      expect(liftedLook("a1")).toBe(true);
      expect(dragState()).toBeNull();
      const { markedAtCommit, onSlot } = rerenderWatchingMarker(view, moved);
      expect(columnOf("a1")).toBe(`col-${columnId}`);
      expect(markedAtCommit).toBe(false);
      expect(onSlot).toEqual([]);
      expect(liftedLook("a1")).toBe(false);
      await settle(status);
      expect(liftedLook("a1")).toBe(false);
    },
  );

  it.each(
    UNSLOTTED.flatMap(([name, columnId, beforeId]) =>
      (["resolve", "reject"] as const).map(
        (how) => [name, how, columnId, beforeId] as const,
      ),
    ),
  )(
    "an unslotted drop (%s) lets go at the settle (%s) when the board never moved it",
    async (_name, how, columnId, beforeId) => {
      const { status } = unslottedDrop(columnId, beforeId);
      expect(liftedLook("a1")).toBe(true);
      await settle(status, how);
      expect(columnOf("a1")).toBe("col-todo");
      expect(liftedLook("a1")).toBe(false);
    },
  );

  it("lets go at a hide, and after a board switch", () => {
    const { host, view } = crossColumnScenario();
    view.rerender(<Shell host={host} mode="hidden" />);
    view.rerender(<Shell host={host} />);
    expect(liftedLook("a1")).toBe(false);
    lift("a1");
    drop({ columnId: "doing", beforeId: "b2" });
    expect(liftedLook("a1")).toBe(true);
    const switched = rerenderWatchingMarker(view, {
      ...host,
      signature: "board-2",
    });
    expect(switched.markedAtCommit).toBe(false);
    expect(liftedLook("a1")).toBe(false);
  });

  it.each([
    ["a status write that sent nothing", "doing", "b2", { status: null }],
    ["a refused drop", "doing", "b2", { moveHeld: MOVE_HELD_REASON }],
    ["a same-column drop that sent nothing", "todo", null, {}],
    [
      "a same-column drop onto its own slot",
      "todo",
      "a2",
      { position: deferred() },
    ],
    ["a release outside every column", null, null, {}],
  ] as const)("leaves %s alone", (_name, columnId, beforeId, extra) => {
    render(<Shell host={baseHost({ status: deferred(), ...extra })} />);
    lift("a1");
    drop(columnId === null ? null : { columnId, beforeId });
    expect(liftedLook("a1")).toBe(false);
  });

  it("leaves a cancel alone", () => {
    render(<Shell host={baseHost({ status: deferred() })} />);
    lift("a1");
    act(() => seam().cancel());
    expect(liftedLook("a1")).toBe(false);
  });
});

describe("the source card after a same-column drop", () => {
  // To do's end lands a1 after a3. Before a3 it lands after b2, a3's nearest
  // live card above once a1 leaves the project order. a2 before a1 has no live
  // card above it: the top of the board.
  const SLOTS = [
    [
      "the end slot",
      "a1",
      null,
      "a3",
      ["b1", "a2", "h1", "r1", "b2", "a3", "a1"],
    ],
    [
      "a middle slot",
      "a1",
      "a3",
      "b2",
      ["b1", "a2", "h1", "r1", "b2", "a1", "a3"],
    ],
    [
      "the first slot",
      "a2",
      "a1",
      null,
      ["a2", "a1", "b1", "h1", "r1", "b2", "a3"],
    ],
  ] as const;

  function sameColumnDrop(moved: string, beforeId: string | null) {
    const position = deferred();
    const host = baseHost({ position });
    const view = render(<Shell host={host} />);
    lift(moved);
    drop({ columnId: "todo", beforeId });
    return { position, host, view };
  }

  /** The board the reorder's splice draws: the base board in `order`. */
  const drawnIn = (order: readonly string[]) =>
    makeHost({
      order: order.map((id) =>
        id === "r1" ? item(id, { redacted: true }) : item(id),
      ),
      place: BASE_PLACE,
      heldIds: ["h1"],
    });

  it.each(SLOTS)(
    "a drop to %s keeps its lifted look until the board draws it there",
    async (_name, moved, beforeId, afterId, order) => {
      const { position, host, view } = sameColumnDrop(moved, beforeId);
      expect(host.writePosition).toHaveBeenCalledWith(
        host.columns[0].items.find((it) => it.itemId === moved),
        afterId,
      );
      expect(liftedLook(moved)).toBe(true);
      expect(dragState()).toBeNull();
      // A board that still draws it at its old slot keeps the look.
      view.rerender(<Shell host={baseHost({ position })} />);
      expect(liftedLook(moved)).toBe(true);
      const { markedAtCommit } = rerenderWatchingMarker(
        view,
        drawnIn(order),
        moved,
      );
      expect(markedAtCommit).toBe(false);
      expect(liftedLook(moved)).toBe(false);
      await settle(position);
      expect(liftedLook(moved)).toBe(false);
    },
  );

  it.each(
    SLOTS.flatMap(([name, moved, beforeId]) =>
      (["resolve", "reject"] as const).map(
        (how) => [name, how, moved, beforeId] as const,
      ),
    ),
  )(
    "a drop to %s lets go at the write's settle (%s) when the board never drew it there",
    async (_name, how, moved, beforeId) => {
      const { position } = sameColumnDrop(moved, beforeId);
      expect(liftedLook(moved)).toBe(true);
      await settle(position, how);
      expect(columnOf(moved)).toBe("col-todo");
      expect(liftedLook(moved)).toBe(false);
    },
  );

  it("lets go before the settle once the board no longer holds the anchor", async () => {
    const { position, view } = sameColumnDrop("a1", null);
    expect(liftedLook("a1")).toBe(true);
    view.rerender(
      <Shell
        host={makeHost({
          order: BASE_ORDER().filter((it) => it.itemId !== "a3"),
          place: BASE_PLACE,
          heldIds: ["h1"],
          position,
        })}
      />,
    );
    expect(columnOf("a1")).toBe("col-todo");
    expect(liftedLook("a1")).toBe(false);
    await settle(position);
    expect(liftedLook("a1")).toBe(false);
  });
});

describe("late settle (AC8)", () => {
  it("skips the slot write after a signature change", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    view.rerender(<Shell host={{ ...settled, signature: "board-2" }} />);
    await settle(status);
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.announce).toHaveBeenCalledTimes(1);
    expect(host.refuse).not.toHaveBeenCalled();
  });

  it("skips the slot write when the target column no longer draws the card", async () => {
    const { status, host, view } = crossColumnScenario();
    view.rerender(<Shell host={baseHost()} />);
    await settle(status);
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.announce).toHaveBeenCalledTimes(1);
  });

  it("skips the slot write after a repo switch", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    view.rerender(<Shell host={settled} />);
    act(() => useUiStore.setState({ repoPath: "C:/repos/other" }));
    await settle(status);
    expect(host.writePosition).not.toHaveBeenCalled();
  });

  it("skips the slot write once the root unmounted", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    view.rerender(<Shell host={settled} />);
    view.rerender(<Shell host={settled} mounted={false} />);
    await settle(status);
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.announce).toHaveBeenCalledTimes(1);
  });

  it("still writes the slot when the root is merely hidden", async () => {
    const { status, host, settled, view } = crossColumnScenario();
    view.rerender(<Shell host={settled} />);
    view.rerender(<Shell host={settled} mode="hidden" />);
    await settle(status);
    expect(host.writePosition).toHaveBeenCalledTimes(1);
  });
});

describe("refusal on release (AC9)", () => {
  it("refuses the end of a column on a truncated board", () => {
    const host = baseHost({ truncated: true });
    render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: null });
    expect(host.refuse).toHaveBeenCalledWith(TRUNCATED_ORDER_REASON.card);
    expect(host.writePosition).not.toHaveBeenCalled();
  });

  it("refuses a held column with moveHeld's reason, asked about the live item", () => {
    const host = baseHost({ moveHeld: MOVE_HELD_REASON });
    render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "doing", beforeId: "b2" });
    expect(host.refuse).toHaveBeenCalledWith(MOVE_HELD_REASON);
    expect(host.moveHeld).toHaveBeenLastCalledWith(host.columns[0].items[0]);
    expect(host.writeStatus).not.toHaveBeenCalled();
  });

  it("refuses a card that became held between lift and drop, gating the live item", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    const held = baseHost({ heldIds: ["h1", "a1"] });
    view.rerender(<Shell host={held} />);
    drop({ columnId: "doing", beforeId: "b2" });
    expect(held.refuse).toHaveBeenCalledWith(HELD_REASON);
    expect(held.repositionHeld).toHaveBeenLastCalledWith(
      held.columns[0].items[0],
    );
    expect(held.repositionHeld.mock.lastCall?.[0]).not.toBe(
      host.columns[0].items[0],
    );
    expect(held.writeStatus).not.toHaveBeenCalled();
    expect(held.writePosition).not.toHaveBeenCalled();
  });

  it("refuses a card archived mid-drag while the host still draws it", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    const archived = makeHost({
      order: [item("a1", { archived: true }), ...BASE_ORDER().slice(1)],
      place: BASE_PLACE,
      heldIds: ["h1"],
    });
    view.rerender(<Shell host={archived} />);
    drop({ columnId: "doing", beforeId: "b2" });
    expect(archived.refuse).toHaveBeenCalledWith(ARCHIVED_REASON);
    expect(archived.repositionHeld).toHaveBeenLastCalledWith(
      archived.columns[0].items[0],
    );
    expect(archived.writeStatus).not.toHaveBeenCalled();
    expect(archived.writePosition).not.toHaveBeenCalled();
  });

  it("ends silently when a refetch stops drawing the card, and the drop writes nothing", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    const { abort } = lift("a1");
    const gone = makeHost({
      order: BASE_ORDER().slice(1),
      place: BASE_PLACE,
      heldIds: ["h1"],
    });
    view.rerender(<Shell host={gone} />);
    expect(abort).toHaveBeenCalledTimes(1);
    drop({ columnId: "doing", beforeId: "b2" });
    expect(gone.refuse).not.toHaveBeenCalled();
    expect(gone.announce).not.toHaveBeenCalled();
    expect(gone.writeStatus).not.toHaveBeenCalled();
  });
});

// To do draws an archived run x1, y1 under l1. In the project order o1, a live
// card of Doing, sits between x1 and the slot card s1, so a slot planned raw
// under the run lands the card below x1.
const ARCHIVED_RUN_ORDER = (moved: string) => [
  item(moved),
  item("l1"),
  item("x1", { archived: true }),
  item("o1"),
  item("y1", { archived: true }),
  item("s1"),
];
const ARCHIVED_RUN_PLACE: HostSpec["place"] = {
  l1: "todo",
  x1: "todo",
  y1: "todo",
  s1: "todo",
  o1: "doing",
};

/** The anchor the planner gives the RESOLVED slot: directly above the run. */
function plannedAboveRun(host: BoardDragHost, movedId: string) {
  const column = host.columns[0];
  return planDrop({
    order: plannerCards(host.loaded, host.restoring),
    column: plannerCards(column.items, host.restoring),
    movedId,
    beforeId: "x1",
    truncated: host.truncated,
  });
}

const todoLine = () =>
  screen.getByTestId("col-todo").querySelectorAll("[data-board-drop-line]");

describe("archived-run slots", () => {
  it("drop below an archived card: the line and the write resolve above the archived run", () => {
    const host = makeHost({
      order: ARCHIVED_RUN_ORDER("m1"),
      place: { ...ARCHIVED_RUN_PLACE, m1: "todo" },
    });
    render(<Shell host={host} />);
    lift("m1");
    hover({ columnId: "todo", beforeId: "s1" });
    // To do draws [m1, l1, x1, y1, s1]: the line sits at x1's row, index 2.
    expect(lines()).toHaveLength(1);
    expect(todoLine()).toHaveLength(1);
    expect((todoLine()[0] as HTMLElement).style.top).toBe(
      `${slotLineY(2, 5, rowAt) - 1}px`,
    );
    expect(dragState()).toBe("lifted");
    drop({ columnId: "todo", beforeId: "s1" });
    expect(plannedAboveRun(host, "m1")).toEqual({
      kind: "move",
      afterId: "l1",
    });
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(
      host.columns[0].items[0],
      "l1",
    );
    expect(host.landCursor).toHaveBeenCalledWith("m1", 0, 1);
    expect(host.announce).toHaveBeenCalledWith("Moved to 2 of 5 in To do");
    expect(host.refuse).not.toHaveBeenCalled();
  });

  it("drop below an archived card from another column pins the slot above the run", async () => {
    const status = deferred();
    const host = makeHost({
      order: ARCHIVED_RUN_ORDER("c1"),
      place: { ...ARCHIVED_RUN_PLACE, c1: "doing" },
      status,
    });
    const view = render(<Shell host={host} />);
    lift("c1");
    drop({ columnId: "todo", beforeId: "s1" });
    expect(host.writeStatus).toHaveBeenCalledWith(
      host.columns[1].items[0],
      "todo",
      { afterId: "l1" },
    );
    expect(host.announce).toHaveBeenCalledWith("Moved to 2 of 5 in To do");
    // The status write's board: c1 drawn in To do, at its old project slot.
    const settled = makeHost({
      order: ARCHIVED_RUN_ORDER("c1"),
      place: { ...ARCHIVED_RUN_PLACE, c1: "todo" },
    });
    view.rerender(<Shell host={settled} />);
    await settle(status);
    expect(plannedAboveRun(settled, "c1")).toEqual({
      kind: "move",
      afterId: "l1",
    });
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(
      settled.columns[0].items[0],
      "l1",
    );
  });

  it("a card with a restore in flight counts as archived: the slot resolves above it", () => {
    const host = makeHost({
      order: ARCHIVED_RUN_ORDER("c1"),
      place: { ...ARCHIVED_RUN_PLACE, c1: "doing" },
      restoring: ["l1"],
      status: deferred(),
    });
    render(<Shell host={host} />);
    lift("c1");
    hover({ columnId: "todo", beforeId: "s1" });
    // To do draws [l1, x1, y1, s1]; restoring l1 heads the run, so slot 0.
    expect(todoLine()).toHaveLength(1);
    expect((todoLine()[0] as HTMLElement).style.top).toBe(
      `${slotLineY(0, 4, rowAt) - 1}px`,
    );
    drop({ columnId: "todo", beforeId: "s1" });
    const plan = planDrop({
      order: plannerCards(host.loaded, host.restoring),
      column: plannerCards(host.columns[0].items, host.restoring),
      movedId: "c1",
      beforeId: "l1",
      truncated: false,
    });
    expect(host.writeStatus).toHaveBeenCalledWith(
      host.columns[1].items[0],
      "todo",
      plan.kind === "move" ? { afterId: plan.afterId } : undefined,
    );
  });

  it("the end slot under a trailing archived run is planned on a truncated board", () => {
    const host = makeHost({
      order: [
        item("m1"),
        item("l1"),
        item("o1"),
        item("x1", { archived: true }),
        item("y1", { archived: true }),
      ],
      place: { m1: "todo", l1: "todo", x1: "todo", y1: "todo", o1: "doing" },
      truncated: true,
    });
    render(<Shell host={host} />);
    lift("m1");
    hover({ columnId: "todo", beforeId: null });
    expect(dragState()).toBe("lifted");
    expect(todoLine()).toHaveLength(1);
    expect((todoLine()[0] as HTMLElement).style.top).toBe(
      `${slotLineY(2, 4, rowAt) - 1}px`,
    );
    drop({ columnId: "todo", beforeId: null });
    expect(host.refuse).not.toHaveBeenCalled();
    expect(plannedAboveRun(host, "m1")).toEqual({
      kind: "move",
      afterId: "o1",
    });
    expect(host.writePosition).toHaveBeenCalledTimes(1);
    expect(host.writePosition).toHaveBeenCalledWith(
      host.columns[0].items[0],
      "o1",
    );
    expect(host.announce).toHaveBeenCalledWith("Moved to 2 of 4 in To do");
  });
});

describe("cancel (AC10)", () => {
  it.each([
    ["drop(null)", () => seam().drop(null), false],
    ["cancel()", () => seam().cancel(), false],
    [
      "a trusted Escape",
      () => pressEscape(screen.getByTestId("card-a1")),
      true,
    ],
    [
      "a right press",
      () => fireEvent.mouseDown(screen.getByTestId("card-a1"), { button: 2 }),
      true,
    ],
    ["a window blur", () => fireEvent.blur(window), true],
  ])(
    "%s ends the session with one announcement and no write",
    (_name, end, aborts) => {
      const host = baseHost();
      render(<Shell host={host} />);
      const { abort } = lift("a1");
      act(() => {
        end();
      });
      expect(host.announce).toHaveBeenCalledTimes(1);
      expect(host.announce).toHaveBeenCalledWith(MOVE_CANCELLED_ANNOUNCEMENT);
      expect(abort).toHaveBeenCalledTimes(aborts ? 1 : 0);
      expect(host.writePosition).not.toHaveBeenCalled();
      expect(host.writeStatus).not.toHaveBeenCalled();
      expect(dragState()).toBeNull();
    },
  );

  it("hides a session Escape from the board and the window, and lets it through without one", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    lift("a1");
    let event = new Event("none");
    act(() => {
      event = pressEscape(screen.getByTestId("card-a1"));
    });
    expect(event.defaultPrevented).toBe(true);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    expect(bubbleKeys).toEqual([]);
    pressEscape(screen.getByTestId("card-a1"));
    expect(ancestorKeyDown).toHaveBeenCalledWith("Escape");
    expect(bubbleKeys).toEqual(["Escape"]);
  });

  it("ignores an untrusted Escape", () => {
    const host = baseHost();
    render(<Shell host={host} />);
    lift("a1");
    act(() => {
      pressEscape(screen.getByTestId("card-a1"), false);
    });
    expect(host.announce).not.toHaveBeenCalled();
    expect(dragState()).toBe("lifted");
  });

  it("swallows the one contextmenu after a right-press cancel", () => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    const card = screen.getByTestId("card-a1");
    act(() => {
      fireEvent.mouseDown(card, { button: 2 });
    });
    const first = fireEvent.contextMenu(card);
    expect(first).toBe(false);
    expect(ancestorContextMenu).not.toHaveBeenCalled();
    expect(fireEvent.contextMenu(card)).toBe(true);
    expect(ancestorContextMenu).toHaveBeenCalledTimes(1);
  });

  it("arms no latch on a middle-press cancel, and a latch is gone after the next mousedown", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    lift("a1");
    act(() => {
      fireEvent.mouseDown(card, { button: 1 });
    });
    expect(fireEvent.contextMenu(card)).toBe(true);
    lift("a1");
    act(() => {
      fireEvent.mouseDown(card, { button: 2 });
    });
    fireEvent.mouseDown(card, { button: 0 });
    expect(fireEvent.contextMenu(card)).toBe(true);
    expect(ancestorContextMenu).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "a key press (trusted %s) after a right-press cancel: a trusted one disarms the latch",
    (trusted) => {
      render(<Shell host={baseHost()} />);
      const card = screen.getByTestId("card-a1");
      lift("a1");
      act(() => {
        fireEvent.mouseDown(card, { button: 2 });
      });
      trust.trusted = trusted;
      try {
        fireEvent.keyDown(card, { key: "F10", shiftKey: true });
      } finally {
        trust.trusted = true;
      }
      expect(fireEvent.contextMenu(card)).toBe(trusted);
      expect(ancestorContextMenu).toHaveBeenCalledTimes(trusted ? 1 : 0);
    },
  );

  it("a held modifier's repeat keeps the latch; a fresh key after a modifier, or the Menu key, disarms it", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    const armLatch = () => {
      lift("a1");
      act(() => {
        fireEvent.mouseDown(card, { button: 2 });
      });
    };
    armLatch();
    fireEvent.keyDown(card, { key: "Shift", shiftKey: true, repeat: true });
    expect(fireEvent.contextMenu(card)).toBe(false);
    armLatch();
    fireEvent.keyDown(card, { key: "ArrowDown", repeat: true });
    expect(fireEvent.contextMenu(card)).toBe(false);
    armLatch();
    fireEvent.keyDown(card, { key: "Shift", shiftKey: true });
    expect(fireEvent.contextMenu(card)).toBe(false);
    armLatch();
    fireEvent.keyDown(card, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    expect(fireEvent.contextMenu(card)).toBe(true);
    armLatch();
    fireEvent.keyDown(card, { key: "ContextMenu" });
    expect(fireEvent.contextMenu(card)).toBe(true);
    expect(ancestorContextMenu).toHaveBeenCalledTimes(2);
  });

  it("a window blur disarms the latch a right-press cancel armed", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    lift("a1");
    act(() => {
      fireEvent.mouseDown(card, { button: 2 });
    });
    fireEvent.blur(window);
    expect(fireEvent.contextMenu(card)).toBe(true);
    expect(ancestorContextMenu).toHaveBeenCalledTimes(1);
  });

  it("a side press that cancels a lifted drag does not go back on its release; the next press does", () => {
    const back = vi.fn();
    function SideButtonNav() {
      useSideButtonNavigation();
      useHotkeyAction("go-back", back);
      return null;
    }
    const host = baseHost();
    render(
      <>
        <SideButtonNav />
        <Shell host={host} />
      </>,
    );
    const card = screen.getByTestId("card-a1");
    lift("a1");
    fireEvent.mouseDown(card, { button: 3 });
    expect(host.announce).toHaveBeenCalledWith(MOVE_CANCELLED_ANNOUNCEMENT);
    expect(dragState()).toBeNull();
    fireEvent.mouseUp(card, { button: 3 });
    expect(back).not.toHaveBeenCalled();
    fireEvent.mouseDown(card, { button: 3 });
    fireEvent.mouseUp(card, { button: 3 });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("seam-owned teardown", () => {
  it("hide mid-drag is a cancel: one abort, one Move cancelled, nothing written", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    const { abort } = lift("a1");
    view.rerender(<Shell host={host} mode="hidden" />);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledWith(MOVE_CANCELLED_ANNOUNCEMENT);
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.writeStatus).not.toHaveBeenCalled();
    expect(host.refuse).not.toHaveBeenCalled();
    const esc = pressEscape(document.body);
    expect(esc.defaultPrevented).toBe(false);
    expect(host.announce).toHaveBeenCalledTimes(1);
  });

  it("unmount mid-drag is a cancel: one abort, one Move cancelled, no window listener", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    const { abort } = lift("a1");
    view.rerender(<Shell host={host} mounted={false} />);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledWith(MOVE_CANCELLED_ANNOUNCEMENT);
    expect(host.writePosition).not.toHaveBeenCalled();
    expect(host.writeStatus).not.toHaveBeenCalled();
    const esc = pressEscape(document.body);
    expect(esc.defaultPrevented).toBe(false);
    expect(bubbleKeys).toEqual(["Escape"]);
    expect(host.announce).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["layout", "hidden"],
    ["layout", "unmounted"],
    ["passive", "hidden"],
    ["passive", "unmounted"],
  ] as const)(
    "a cancel reported from an engine's own %s cleanup adds no second announcement (panel %s)",
    (cleanup, end) => {
      const host = baseHost();
      const view = render(<Shell host={host} />);
      const { abort } = lift("a1");
      fake.cleanupCancel = cleanup;
      view.rerender(
        end === "hidden" ? (
          <Shell host={host} mode="hidden" />
        ) : (
          <Shell host={host} mounted={false} />
        ),
      );
      fake.cleanupCancel = null;
      expect(host.announce).toHaveBeenCalledTimes(1);
      expect(host.announce).toHaveBeenCalledWith(MOVE_CANCELLED_ANNOUNCEMENT);
      expect(abort.mock.calls.length).toBeLessThanOrEqual(1);
      expect(host.writePosition).not.toHaveBeenCalled();
      expect(host.writeStatus).not.toHaveBeenCalled();
    },
  );

  it("a re-shown panel starts with no session and lifts again", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    hover({ columnId: "doing", beforeId: "b2" });
    view.rerender(<Shell host={host} mode="hidden" />);
    view.rerender(<Shell host={host} />);
    expect(dragState()).toBeNull();
    expect(lines()).toHaveLength(0);
    expect(screen.getByTestId("card-a1").parentElement).not.toHaveAttribute(
      "data-board-drag-source",
    );
    act(() => seam().cancel());
    expect(host.announce).toHaveBeenCalledTimes(1);
    const again = lift("a2");
    expect(again.started).toBe(true);
    expect(dragState()).toBe("lifted");
    drop({ columnId: "todo", beforeId: null });
    expect(host.writePosition).toHaveBeenCalledTimes(1);
  });

  it("a refused lift, then a hide: no block, cursor, click swallow or latch after the re-show", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    const card = screen.getByTestId("card-a1");
    lift("a1");
    act(() => {
      fireEvent.mouseDown(card, { button: 2 });
    });
    // The right-press cancel armed the latch; the refusal blocks and arms the swallow.
    expect(lift("h1").started).toBe(false);
    expect(dragState()).toBe("blocked");
    view.rerender(<Shell host={host} mode="hidden" />);
    view.rerender(<Shell host={host} />);
    expect(dragState()).toBeNull();
    const tokens = [
      ...DRAG_DOCUMENT_TOKENS.lifted,
      ...DRAG_DOCUMENT_TOKENS.blocked,
    ];
    expect(
      tokens.filter((t) => document.documentElement.classList.contains(t)),
    ).toEqual([]);
    // A keyboard-activated click carries no detail.
    fireEvent.click(screen.getByTestId("card-a2"), { detail: 0 });
    expect(cardClick).toHaveBeenCalledWith("a2");
    expect(fireEvent.contextMenu(card)).toBe(true);
    expect(ancestorContextMenu).toHaveBeenCalledTimes(1);
  });
});

describe("click swallow (AC12)", () => {
  it("swallows the one click after a lift and drop", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    lift("a1");
    drop({ columnId: "todo", beforeId: "a2" });
    fireEvent.mouseUp(card);
    fireEvent.click(card);
    expect(cardClick).not.toHaveBeenCalled();
    fireEvent.click(card);
    expect(cardClick).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a cancel", () => seam().cancel()],
    [
      "a blocked press",
      () =>
        seam().lift({ itemId: "h1", pointer: { x: 0, y: 0 }, abort: vi.fn() }),
    ],
  ])("swallows the click after %s", (_name, gesture) => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    if (_name === "a cancel") lift("a1");
    act(() => {
      gesture();
    });
    fireEvent.mouseUp(card);
    fireEvent.click(card);
    expect(cardClick).not.toHaveBeenCalled();
  });

  it.each([
    ["right", 2],
    ["middle", 1],
  ] as const)(
    "a %s press and release that cancel the lift leave the primary release's click swallowed",
    async (_name, button) => {
      render(<Shell host={baseHost()} />);
      const card = screen.getByTestId("card-a1");
      lift("a1");
      act(() => {
        fireEvent.mouseDown(card, { button });
      });
      expect(dragState()).toBeNull();
      fireEvent.mouseUp(card, { button });
      // The other button's release lands a task before the primary's.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      fireEvent.mouseUp(card);
      fireEvent.click(card);
      expect(cardClick).not.toHaveBeenCalled();
    },
  );

  it("never swallows a press that did not lift", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    fireEvent.mouseUp(card);
    fireEvent.click(card);
    expect(cardClick).toHaveBeenCalledTimes(1);
  });

  it("swallows a click in the same task as the lift", () => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    act(() => {
      seam().lift({ itemId: "a1", pointer: { x: 0, y: 0 }, abort: vi.fn() });
      seam().drop({ columnId: "todo", beforeId: "a2" });
      fireEvent.mouseUp(card);
      fireEvent.click(card);
    });
    expect(cardClick).not.toHaveBeenCalled();
  });

  it.each([
    ["a window blur", () => fireEvent.blur(window)],
    [
      "the next mousedown",
      () => fireEvent.mouseDown(screen.getByTestId("card-a2")),
    ],
  ])("is disarmed by %s", (_name, disarm) => {
    render(<Shell host={baseHost()} />);
    const card = screen.getByTestId("card-a1");
    lift("a1");
    drop({ columnId: "todo", beforeId: "a2" });
    act(() => {
      disarm();
    });
    fireEvent.click(card);
    expect(cardClick).toHaveBeenCalledTimes(1);
  });
});

describe("silent ends (AC13)", () => {
  function expectNoListener() {
    pressEscape(screen.getByTestId("card-a2"));
    expect(ancestorKeyDown).toHaveBeenCalledWith("Escape");
  }

  it("ends silently on a signature change", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    const { abort } = lift("a1");
    const next = baseHost({ signature: "board-2" });
    view.rerender(<Shell host={next} />);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(host.announce).not.toHaveBeenCalled();
    expect(next.announce).not.toHaveBeenCalled();
    expectNoListener();
  });

  it("ends silently when the card leaves every column", () => {
    const view = render(<Shell host={baseHost()} />);
    const { abort } = lift("a1");
    const gone = makeHost({ order: BASE_ORDER().slice(1), place: BASE_PLACE });
    view.rerender(<Shell host={gone} />);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(gone.announce).not.toHaveBeenCalled();
    expectNoListener();
  });

  it("yields one abort and one announcement for lift + Escape under StrictMode", () => {
    const host = baseHost();
    render(
      <StrictMode>
        <Shell host={host} />
      </StrictMode>,
    );
    const { abort } = lift("a1");
    act(() => {
      pressEscape(screen.getByTestId("card-a1"));
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledTimes(1);
  });

  it("treats a mirror from another board as no session", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    const next = baseHost({ signature: "board-2" });
    view.rerender(<Shell host={next} />);
    drop({ columnId: "todo", beforeId: null });
    act(() => seam().cancel());
    expect(next.writePosition).not.toHaveBeenCalled();
    expect(next.announce).not.toHaveBeenCalled();
    expect(lift("a1").started).toBe(true);
  });
});

const fadingGhost = () =>
  document.querySelector<HTMLElement>("[data-board-drag-ghost-fade]");
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function expectFadingGhost(title: string) {
  const clone = fadingGhost();
  expect(clone).not.toBeNull();
  expect(clone?.parentElement).toBe(document.body);
  expect(clone).toHaveAttribute("aria-hidden", "true");
  expect(clone).toHaveAttribute("inert");
  expect(clone).not.toHaveAttribute("data-board-drag-ghost");
  expect(clone?.className).toContain("pointer-events-none");
  expect(clone?.style.animationDuration).toBe(`${GHOST_FADE_MS}ms`);
  expect(within(clone as HTMLElement).getByText(title)).toBeInTheDocument();
}

const CANCELS: [string, () => void][] = [
  ["drop(null)", () => seam().drop(null)],
  ["cancel()", () => seam().cancel()],
  ["a trusted Escape", () => pressEscape(screen.getByTestId("card-a1"))],
  [
    "a right press",
    () => fireEvent.mouseDown(screen.getByTestId("card-a1"), { button: 2 }),
  ],
  ["a window blur", () => fireEvent.blur(window)],
];

describe("fading ghost (AC14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drop: a fading ghost stays at the drop point for 120 ms", () => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: null });
    expectFadingGhost("Card a1");
    expect(within(ghostBox()).queryByText("Card a1")).toBeNull();
    tick(GHOST_FADE_MS - 1);
    expect(fadingGhost()).not.toBeNull();
    tick(1);
    expect(fadingGhost()).toBeNull();
  });

  it.each(CANCELS)(
    "cancel: a fading ghost stays for 120 ms after %s",
    (_name, end) => {
      render(<Shell host={baseHost()} />);
      lift("a1");
      act(() => {
        end();
      });
      expectFadingGhost("Card a1");
      tick(GHOST_FADE_MS - 1);
      expect(fadingGhost()).not.toBeNull();
      tick(1);
      expect(fadingGhost()).toBeNull();
    },
  );

  it("the fading copy takes the box the ghost last had", () => {
    render(<Shell host={baseHost()} />);
    const boxOf = (clone: HTMLElement | null) => {
      const s = clone?.style;
      return [s?.left, s?.top, s?.width, s?.height];
    };
    const placeGhost = (rect: Omit<DOMRect, "toJSON">) => {
      const node = ghostBox().querySelector("[data-board-drag-ghost]");
      if (node === null) throw new Error("no ghost drawn");
      Object.defineProperty(node, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ ...rect, toJSON: () => ({}) }),
      });
    };
    lift("a1");
    placeGhost({
      left: 11,
      top: 23,
      width: 270,
      height: 54,
      right: 281,
      bottom: 77,
      x: 11,
      y: 23,
    });
    drop({ columnId: "todo", beforeId: null });
    expect(boxOf(fadingGhost())).toEqual(["11px", "23px", "270px", "54px"]);
    lift("a2");
    placeGhost({
      left: 305,
      top: 140,
      width: 260,
      height: 61,
      right: 565,
      bottom: 201,
      x: 305,
      y: 140,
    });
    act(() => seam().cancel());
    expect(boxOf(fadingGhost())).toEqual(["305px", "140px", "260px", "61px"]);
  });

  it("reduced motion: no fading ghost", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
    }));
    render(<Shell host={baseHost()} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: null });
    expect(fadingGhost()).toBeNull();
    for (const [, end] of CANCELS) {
      lift("a1");
      act(() => {
        end();
      });
      expect(fadingGhost()).toBeNull();
    }
  });

  it("a new lift, a hide and an unmount remove the fading ghost at once", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    drop({ columnId: "todo", beforeId: null });
    expect(fadingGhost()).not.toBeNull();
    lift("a2");
    expect(fadingGhost()).toBeNull();
    drop(null);
    expect(fadingGhost()).not.toBeNull();
    view.rerender(<Shell host={host} mode="hidden" />);
    expect(fadingGhost()).toBeNull();
    view.rerender(<Shell host={host} />);
    lift("a1");
    act(() => seam().cancel());
    expect(fadingGhost()).not.toBeNull();
    view.rerender(<Shell host={host} mounted={false} />);
    expect(fadingGhost()).toBeNull();
  });

  it("no fading ghost on a hide, an unmount or a silent end", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    view.rerender(<Shell host={host} mode="hidden" />);
    expect(fadingGhost()).toBeNull();
    view.rerender(<Shell host={host} />);
    lift("a1");
    const next = baseHost({ signature: "board-2" });
    view.rerender(<Shell host={next} />);
    expect(fadingGhost()).toBeNull();
    lift("a1");
    view.rerender(<Shell host={next} mounted={false} />);
    expect(fadingGhost()).toBeNull();
  });
});

describe("document cursor tokens (AC15)", () => {
  const root = () => document.documentElement.classList;
  const has = (tokens: readonly string[]) =>
    tokens.every((t) => root().contains(t));
  const none = () =>
    [...DRAG_DOCUMENT_TOKENS.lifted, ...DRAG_DOCUMENT_TOKENS.blocked].every(
      (t) => !root().contains(t),
    );
  const NOT_ALLOWED = "[&_*]:cursor-not-allowed!";
  const GRABBING = "[&_*]:cursor-grabbing!";

  afterEach(() => {
    root().remove("dark", "select-none");
  });

  it("the drag cursor tokens are on the document while lifted or blocked and gone at every end", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    expect(none()).toBe(true);
    lift("a1");
    expect(has(DRAG_DOCUMENT_TOKENS.lifted)).toBe(true);
    expect(root().contains(NOT_ALLOWED)).toBe(false);
    hover({ columnId: "doing", beforeId: "b2" });
    expect(has(DRAG_DOCUMENT_TOKENS.lifted)).toBe(true);
    drop({ columnId: "doing", beforeId: "b2" });
    expect(none()).toBe(true);
    view.unmount();
  });

  it("holds the blocked tokens over a refused target", () => {
    render(<Shell host={baseHost({ truncated: true })} />);
    lift("a1");
    hover({ columnId: "todo", beforeId: null });
    expect(has(DRAG_DOCUMENT_TOKENS.blocked)).toBe(true);
    expect(root().contains(GRABBING)).toBe(false);
    hover({ columnId: "doing", beforeId: "b2" });
    expect(has(DRAG_DOCUMENT_TOKENS.lifted)).toBe(true);
    expect(root().contains(NOT_ALLOWED)).toBe(false);
  });

  it.each([
    ["a drop", () => seam().drop({ columnId: "todo", beforeId: null })],
    ["a cancel", () => seam().cancel()],
  ])("removes every token at %s", (_name, end) => {
    render(<Shell host={baseHost()} />);
    lift("a1");
    act(() => {
      end();
    });
    expect(none()).toBe(true);
  });

  it("holds the blocked tokens through a refused lift and removes them at its release", () => {
    render(<Shell host={baseHost()} />);
    expect(lift("h1").started).toBe(false);
    expect(has(DRAG_DOCUMENT_TOKENS.blocked)).toBe(true);
    act(() => {
      fireEvent.mouseUp(screen.getByTestId("card-h1"));
    });
    expect(none()).toBe(true);
  });

  it("removes every token at a silent end", () => {
    const view = render(<Shell host={baseHost()} />);
    lift("a1");
    view.rerender(<Shell host={baseHost({ signature: "board-2" })} />);
    expect(none()).toBe(true);
  });

  it("removes every token at a hide", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    view.rerender(<Shell host={host} mode="hidden" />);
    expect(none()).toBe(true);
  });

  it("removes every token at an unmount", () => {
    const host = baseHost();
    const view = render(<Shell host={host} />);
    lift("a1");
    view.rerender(<Shell host={host} mounted={false} />);
    expect(none()).toBe(true);
  });

  it("keeps a class the document carried before the drag", () => {
    root().add("dark", "select-none");
    render(<Shell host={baseHost()} />);
    lift("a1");
    expect(has(DRAG_DOCUMENT_TOKENS.lifted)).toBe(true);
    drop(null);
    expect(root().contains("dark")).toBe(true);
    expect(root().contains("select-none")).toBe(true);
    expect(root().contains(GRABBING)).toBe(false);
  });
});
