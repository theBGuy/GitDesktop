import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardDragCardSlot } from "@/features/projects/drag/BoardDragRoot";
import type {
  BoardDragColumnHandle,
  BoardDragSeam,
  BoardDragTarget,
  DragPoint,
} from "@/features/projects/drag/engine";
import { pointerEngine } from "@/features/projects/drag/engine-pointer";
import { TabPanel } from "@/features/repository/TabPanel";

// The seam is a fake the engine reaches through the mocked context hook; each
// test reads what the engine called on it.
const fake = vi.hoisted(() => ({ seam: null as unknown as FakeSeam }));

vi.mock("@/features/projects/drag/seam-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/projects/drag/seam-context")
  >()),
  useBoardDragSeam: () => fake.seam,
}));

vi.mock("@/features/projects/drag/BoardDragGhost", () => ({
  BoardDragGhost: () => <span data-testid="ghost-content" />,
  BoardDragGhostFade: () => null,
}));

interface FakeSeam extends BoardDragSeam {
  columns: ReturnType<typeof vi.fn<BoardDragSeam["columns"]>>;
  boardScrollEl: ReturnType<typeof vi.fn<BoardDragSeam["boardScrollEl"]>>;
  targetAt: ReturnType<typeof vi.fn<BoardDragSeam["targetAt"]>>;
  lift: ReturnType<typeof vi.fn<BoardDragSeam["lift"]>>;
  hover: ReturnType<typeof vi.fn<BoardDragSeam["hover"]>>;
  drop: ReturnType<typeof vi.fn<BoardDragSeam["drop"]>>;
  cancel: ReturnType<typeof vi.fn<BoardDragSeam["cancel"]>>;
}

// --- geometry: jsdom lays nothing out, so rects come from a data attribute ---

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

/** A scroller whose rect and scroll offsets are plain stored numbers. */
function scroller(rect: string, start = 100) {
  const el = document.createElement("div");
  el.dataset.rect = rect;
  for (const prop of ["scrollTop", "scrollLeft"]) {
    let value = start;
    Object.defineProperty(el, prop, {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = next;
      },
    });
  }
  return el;
}

// --- the fake seam ---

let liftResult = true;
let liftHook: (() => void) | null = null;
let aborts: (() => void)[] = [];
let column: HTMLElement;
let board: HTMLElement;

const targetFor = (p: DragPoint): BoardDragTarget | null =>
  p.x < 0 ? null : { columnId: "c1", beforeId: `at-${p.x}-${p.y}` };

function makeSeam(): FakeSeam {
  // Column 1 spans x [0, 300) and y [0, 500]; the board spans x [0, 1000].
  column = scroller("0,0,300,500");
  board = scroller("0,0,1000,600");
  const handle: BoardDragColumnHandle = {
    columnId: "c1",
    scrollEl: column,
    itemIds: ["a", "b"],
    rowAt: (index) => ({ start: index * 70, size: 70 }),
  };
  return {
    columns: vi.fn(() => [handle]),
    boardScrollEl: vi.fn(() => board),
    targetAt: vi.fn(targetFor),
    lift: vi.fn((args) => {
      aborts.push(args.abort);
      liftHook?.();
      return liftResult;
    }),
    hover: vi.fn(),
    drop: vi.fn(),
    cancel: vi.fn(),
  };
}

// --- a manual frame queue ---

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function runFrame(ts: number) {
  const queued = [...frames];
  frames = new Map();
  for (const [, cb] of queued) cb(ts);
}

// --- pointer capture, which jsdom does not implement ---

const captured = new Map<Element, number>();
const setCapture = vi.fn(function (this: Element, id: number) {
  captured.set(this, id);
});
const releaseCapture = vi.fn(function (this: Element, _id: number) {
  captured.delete(this);
});
const hasCapture = vi.fn(function (this: Element, id: number) {
  return captured.get(this) === id;
});
const CAPTURE_API = {
  setPointerCapture: setCapture,
  releasePointerCapture: releaseCapture,
  hasPointerCapture: hasCapture,
};
const savedCaptureApi = new Map<string, PropertyDescriptor | undefined>();

// --- listener bookkeeping ---

interface Entry {
  type: string;
  fn: unknown;
  capture: boolean;
}
const captureOf = (opts: unknown) =>
  typeof opts === "boolean"
    ? opts
    : Boolean((opts as { capture?: boolean } | undefined)?.capture);

let added: Entry[] = [];
let removed: Entry[] = [];
let documentAdded: Entry[] = [];

/** Adds with no matching removal since the last reset. */
function unmatched(adds: Entry[], removals: Entry[]) {
  const left = [...removals];
  return adds.filter((a) => {
    const i = left.findIndex(
      (r) => r.type === a.type && r.fn === a.fn && r.capture === a.capture,
    );
    if (i === -1) return true;
    left.splice(i, 1);
    return false;
  });
}

function resetListenerLog() {
  added = [];
  removed = [];
  documentAdded = [];
}

const GESTURE_TYPES = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "lostpointercapture",
  "blur",
];

// --- the board under test ---

const ancestorPointerDown = vi.fn();
const ancestorMouseDown = vi.fn();
const Provider = pointerEngine.Provider;

function Slot({ id, disabled }: { id: string; disabled: boolean }) {
  const bind = pointerEngine.useCard({ itemId: id, disabled });
  return (
    <div
      data-testid={`slot-${id}`}
      data-rect="100,200,280,70"
      ref={bind.ref}
      onPointerDown={bind.onPointerDown}
    >
      <button type="button" data-testid={`card-${id}`}>
        {id}
      </button>
    </div>
  );
}

function Shell({
  mode = "visible",
  mounted = true,
  showA = true,
  disabled = false,
}: {
  mode?: "visible" | "hidden";
  mounted?: boolean;
  showA?: boolean;
  disabled?: boolean;
}) {
  return (
    <TabPanel active={mode === "visible"}>
      {mounted && (
        <Provider>
          <div
            data-testid="ancestor"
            onPointerDown={() => ancestorPointerDown()}
            onMouseDown={() => ancestorMouseDown()}
          >
            {showA && <Slot id="a" disabled={disabled} />}
            <Slot id="b" disabled={false} />
          </div>
          <button type="button" data-testid="other">
            other
          </button>
        </Provider>
      )}
    </TabPanel>
  );
}

const layer = () => {
  const el = document.querySelector<HTMLElement>(
    "[data-board-drag-pointer-layer]",
  );
  if (el === null) throw new Error("no capture layer");
  return el;
};
const ghostBox = () => {
  const el = document.querySelector<HTMLElement>(
    "[data-board-drag-pointer-ghost]",
  );
  if (el === null) throw new Error("no ghost box");
  return el;
};
const ghostVisible = () => ghostBox().style.visibility === "visible";

const PRESS = { x: 110, y: 215 };

function pointerInit(x: number, y: number, extra: object = {}) {
  return {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    ...extra,
  };
}

const press = (id = "a", extra: object = {}, at = PRESS) =>
  fireEvent.pointerDown(
    screen.getByTestId(`slot-${id}`),
    pointerInit(at.x, at.y, extra),
  );
const move = (x: number, y: number, extra: object = {}) =>
  fireEvent.pointerMove(document.body, pointerInit(x, y, extra));
const release = (x: number, y: number, extra: object = {}) =>
  fireEvent.pointerUp(
    document.body,
    pointerInit(x, y, { buttons: 0, ...extra }),
  );
const windowBlur = () => fireEvent.blur(window);

/** Press `a` and cross the threshold at (300, 400). */
function liftA() {
  press();
  move(300, 400);
}

let seam: FakeSeam;

beforeEach(() => {
  liftResult = true;
  liftHook = null;
  aborts = [];
  seam = makeSeam();
  fake.seam = seam;
  ancestorPointerDown.mockClear();
  ancestorMouseDown.mockClear();
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return rectOf(this.dataset.rect);
    },
  );
  captured.clear();
  for (const [name, fn] of Object.entries(CAPTURE_API)) {
    savedCaptureApi.set(
      name,
      Object.getOwnPropertyDescriptor(Element.prototype, name),
    );
    fn.mockClear();
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value: fn,
    });
  }
  resetListenerLog();
  const addWindow = window.addEventListener.bind(window);
  const removeWindow = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, fn, opts) => {
    added.push({ type, fn, capture: captureOf(opts) });
    addWindow(type, fn, opts);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation(
    (type, fn, opts) => {
      removed.push({ type, fn, capture: captureOf(opts) });
      removeWindow(type, fn, opts);
    },
  );
  const addDocument = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(
    (type, fn, opts) => {
      documentAdded.push({ type, fn, capture: captureOf(opts) });
      addDocument(type, fn, opts);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, saved] of savedCaptureApi) {
    if (saved === undefined)
      delete (Element.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(Element.prototype, name, saved);
  }
  savedCaptureApi.clear();
});

/** Renders the shell and starts the listener log after the mount. */
function mount(props: Parameters<typeof Shell>[0] = {}, strict = false) {
  const tree = strict ? (
    <StrictMode>
      <Shell {...props} />
    </StrictMode>
  ) : (
    <Shell {...props} />
  );
  const view = render(tree);
  resetListenerLog();
  const rerender = (next: Parameters<typeof Shell>[0]) =>
    view.rerender(
      strict ? (
        <StrictMode>
          <Shell {...next} />
        </StrictMode>
      ) : (
        <Shell {...next} />
      ),
    );
  return { ...view, rerender };
}

const noSeamCalls = () => {
  expect(seam.hover).not.toHaveBeenCalled();
  expect(seam.drop).not.toHaveBeenCalled();
  expect(seam.cancel).not.toHaveBeenCalled();
};

const clearSeamCalls = () => {
  for (const fn of [seam.lift, seam.hover, seam.drop, seam.cancel])
    fn.mockClear();
};

describe("pointer engine: the gesture", () => {
  it("B1 press under the threshold: no lift, nothing shown", () => {
    mount();
    press();
    move(PRESS.x + 4, PRESS.y);
    move(PRESS.x + 2.9, PRESS.y + 2.9);
    expect(seam.lift).not.toHaveBeenCalled();
    expect(ghostVisible()).toBe(false);
    release(PRESS.x + 2.9, PRESS.y + 2.9);
    noSeamCalls();
    expect(unmatched(added, removed)).toEqual([]);
  });

  it("B2 lift: crossing 5 px calls lift once with the current point", () => {
    mount();
    press();
    move(PRESS.x + 3, PRESS.y + 4);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    expect(seam.lift.mock.calls[0][0]).toMatchObject({
      itemId: "a",
      pointer: { x: PRESS.x + 3, y: PRESS.y + 4 },
    });
    expect(seam.hover).not.toHaveBeenCalled();
    const points = [
      { x: 150, y: 250 },
      { x: 160, y: 260 },
      { x: 170, y: 270 },
    ];
    for (const p of points) move(p.x, p.y);
    expect(seam.hover.mock.calls.map((c) => c[0])).toEqual(
      points.map(targetFor),
    );
    expect(seam.lift).toHaveBeenCalledTimes(1);
  });

  it("B3 lift refused: nothing shown and nothing more", () => {
    liftResult = false;
    mount();
    liftA();
    expect(seam.lift).toHaveBeenCalledTimes(1);
    expect(ghostVisible()).toBe(false);
    move(310, 410);
    release(310, 410);
    noSeamCalls();
    expect(setCapture).not.toHaveBeenCalled();
    expect(unmatched(added, removed)).toEqual([]);
  });

  it("B3 lift refused: the next press still lifts", () => {
    liftResult = false;
    mount();
    liftA();
    release(300, 400);
    liftResult = true;
    liftA();
    expect(seam.lift).toHaveBeenCalledTimes(2);
    expect(ghostVisible()).toBe(true);
    move(150, 250);
    release(150, 250);
    expect(seam.hover).toHaveBeenCalledTimes(1);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(unmatched(added, removed)).toEqual([]);
  });

  it.each([
    ["shift", { shiftKey: true }, false],
    ["alt", { altKey: true }, false],
    ["middle button", { button: 1, buttons: 4 }, false],
    ["right button", { button: 2, buttons: 2 }, false],
    ["touch", { pointerType: "touch" }, false],
    ["pen", { pointerType: "pen" }, false],
    ["not primary", { isPrimary: false }, false],
    ["disabled", {}, true],
  ])(
    "B4 not a lift press: modifier, other button, touch, disabled (%s)",
    (_name, extra, disabled) => {
      mount({ disabled });
      press("a", extra);
      move(PRESS.x + 20, PRESS.y, extra);
      expect(seam.lift).not.toHaveBeenCalled();
      expect(added).toEqual([]);
    },
  );

  it("B5 the press is never default-prevented or stopped", () => {
    mount();
    expect(press()).toBe(true);
    expect(ancestorPointerDown).toHaveBeenCalledTimes(1);
    expect(fireEvent.mouseDown(screen.getByTestId("slot-a"))).toBe(true);
    expect(ancestorMouseDown).toHaveBeenCalledTimes(1);
    move(300, 400);
    release(300, 400);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(fireEvent.mouseUp(screen.getByTestId("slot-a"))).toBe(true);
    expect(fireEvent.click(screen.getByTestId("slot-a"))).toBe(true);
  });

  it("B6 capture: taken on the layer at the lift, never at the press", () => {
    mount();
    press();
    move(PRESS.x + 2, PRESS.y);
    expect(setCapture).not.toHaveBeenCalled();
    move(300, 400);
    expect(setCapture).toHaveBeenCalledTimes(1);
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(setCapture.mock.contexts[0]).toBe(layer());
    expect(setCapture.mock.contexts[0]).not.toBe(screen.getByTestId("slot-a"));
    release(300, 400);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(releaseCapture.mock.contexts[0]).toBe(layer());
  });

  it("B7 ghost: the slot's box at lift, the press-time grab offset", () => {
    mount();
    expect(ghostBox().parentElement).toBe(document.body);
    expect(ghostBox().className).toContain("pointer-events-none");
    expect(ghostBox().className).toContain("fixed");
    liftA();
    const box = ghostBox();
    expect(box.style.width).toBe("280px");
    expect(box.style.height).toBe("70px");
    expect(ghostVisible()).toBe(true);
    expect(box.style.transform).toBe("translate3d(290px, 385px, 0px)");
    move(310, 420);
    expect(box.style.transform).toBe("translate3d(300px, 405px, 0px)");
    release(310, 420);
    expect(ghostVisible()).toBe(false);
    expect(box.style.transform).toBe("");
    expect(box.style.width).toBe("");
  });

  it.each([
    ["drop", () => release(300, 400), () => seam.drop],
    ["a lost release", () => move(300, 400, { buttons: 0 }), () => seam.cancel],
    [
      "a pointercancel",
      () => fireEvent.pointerCancel(document.body, pointerInit(300, 400)),
      () => seam.cancel,
    ],
    [
      "a lost capture",
      () => fireEvent.lostPointerCapture(layer(), pointerInit(300, 400)),
      () => seam.cancel,
    ],
  ] as const)(
    "B7 ghost: keeps its placement until the report of %s has returned",
    (_name, end, report) => {
      mount();
      liftA();
      const box = ghostBox();
      let seen: { visible: boolean; transform: string; width: string } | null =
        null;
      report().mockImplementation(() => {
        seen = {
          visible: ghostVisible(),
          transform: box.style.transform,
          width: box.style.width,
        };
      });
      end();
      expect(report()).toHaveBeenCalledTimes(1);
      expect(seen).toEqual({
        visible: true,
        transform: "translate3d(290px, 385px, 0px)",
        width: "280px",
      });
      expect(ghostVisible()).toBe(false);
    },
  );

  it("B8 drop: the release point is re-hit-tested", () => {
    mount();
    liftA();
    move(150, 250);
    release(160, 290);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(seam.drop).toHaveBeenCalledWith(targetFor({ x: 160, y: 290 }));
    liftA();
    release(-5, 290);
    expect(seam.drop).toHaveBeenCalledTimes(2);
    expect(seam.drop).toHaveBeenLastCalledWith(null);
    expect(seam.cancel).not.toHaveBeenCalled();
  });

  it("B9 cancel: pointercancel and lost capture each cancel once", () => {
    mount();
    liftA();
    // Another pointer's events are ignored while lifted.
    move(150, 250, { pointerId: 2 });
    release(150, 250, { pointerId: 2 });
    fireEvent.pointerCancel(
      document.body,
      pointerInit(150, 250, { pointerId: 2 }),
    );
    expect(seam.hover).not.toHaveBeenCalled();
    noSeamCalls();
    fireEvent.pointerCancel(document.body, pointerInit(150, 250));
    expect(seam.cancel).toHaveBeenCalledTimes(1);

    liftA();
    fireEvent.lostPointerCapture(
      screen.getByTestId("slot-a"),
      pointerInit(150, 250),
    );
    expect(seam.cancel).toHaveBeenCalledTimes(1);
    fireEvent.lostPointerCapture(layer(), pointerInit(150, 250));
    expect(seam.cancel).toHaveBeenCalledTimes(2);

    liftA();
    release(300, 400);
    fireEvent.lostPointerCapture(layer(), pointerInit(300, 400));
    expect(seam.cancel).toHaveBeenCalledTimes(2);

    // And while only pressed.
    press();
    move(300, 400, { pointerId: 2 });
    expect(seam.lift).toHaveBeenCalledTimes(3);
    fireEvent.pointerCancel(document.body, pointerInit(PRESS.x, PRESS.y));
    move(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(3);
    expect(seam.cancel).toHaveBeenCalledTimes(2);
  });

  it("B10 abort and unmount: stop tracking and call nothing (a) abort mid-session", () => {
    mount();
    liftA();
    const pending = [...frames.keys()];
    expect(pending).toHaveLength(1);
    aborts[0]();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pending[0]);
    expect(ghostVisible()).toBe(false);
    move(310, 410);
    release(310, 410);
    runFrame(1000);
    noSeamCalls();
    aborts[0]();
    noSeamCalls();
    expect(unmatched(added, removed)).toEqual([]);
  });

  it("B10 abort and unmount: (b) abort inside lift", () => {
    liftHook = () => aborts[0]();
    mount();
    liftA();
    expect(seam.lift).toHaveBeenCalledTimes(1);
    expect(setCapture).not.toHaveBeenCalled();
    expect(ghostVisible()).toBe(false);
    expect(frames.size).toBe(0);
    move(310, 410);
    release(310, 410);
    noSeamCalls();
    expect(unmatched(added, removed)).toEqual([]);
  });

  it("B10 abort and unmount: (c) Provider unmounted mid-session and mid-press", () => {
    const view = mount();
    liftA();
    view.rerender({ mounted: false });
    // The seam ends its own session; the engine's cleanup reports nothing.
    expect(seam.cancel).not.toHaveBeenCalled();
    move(310, 410);
    release(310, 410);
    runFrame(1000);
    expect(seam.cancel).not.toHaveBeenCalled();
    expect(seam.hover).not.toHaveBeenCalled();
    expect(seam.drop).not.toHaveBeenCalled();
    expect(unmatched(added, removed)).toEqual([]);

    clearSeamCalls();
    view.rerender({});
    press();
    view.rerender({ mounted: false });
    move(300, 400);
    release(300, 400);
    expect(seam.lift).not.toHaveBeenCalled();
    noSeamCalls();
  });

  it("B10 abort and unmount: (d) hidden panel mid-session, then shown again", () => {
    const view = mount();
    liftA();
    const pending = [...frames.keys()];
    view.rerender({ mode: "hidden" });
    expect(seam.cancel).not.toHaveBeenCalled();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pending[0]);
    expect(frames.size).toBe(0);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(unmatched(added, removed)).toEqual([]);
    expect(documentAdded).toEqual([]);
    move(310, 410);
    release(310, 410);
    expect(seam.hover).not.toHaveBeenCalled();
    expect(seam.drop).not.toHaveBeenCalled();

    view.rerender({ mode: "visible" });
    liftA();
    release(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(2);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(seam.cancel).not.toHaveBeenCalled();
  });

  it("B10 abort and unmount: (d) hidden panel mid-press calls nothing", () => {
    const view = mount();
    press();
    view.rerender({ mode: "hidden" });
    expect(unmatched(added, removed)).toEqual([]);
    move(300, 400);
    expect(seam.lift).not.toHaveBeenCalled();
    noSeamCalls();
  });

  it("B11 StrictMode: one gesture, one lift, one hover per move, one drop", () => {
    mount({}, true);
    liftA();
    move(150, 250);
    move(160, 260);
    release(160, 260);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    expect(seam.hover).toHaveBeenCalledTimes(2);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(setCapture).toHaveBeenCalledTimes(1);
    expect(unmatched(added, removed)).toEqual([]);
  });

  it("B12 back-to-back gestures: the second press lifts again", () => {
    mount();
    liftA();
    release(300, 400);
    liftA();
    release(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(2);
    expect(seam.drop).toHaveBeenCalledTimes(2);
    liftA();
    fireEvent.pointerCancel(document.body, pointerInit(300, 400));
    liftA();
    aborts[aborts.length - 1]();
    liftA();
    release(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(5);
    expect(seam.drop).toHaveBeenCalledTimes(3);
    expect(seam.cancel).toHaveBeenCalledTimes(1);
  });

  it("B13 slot unmount mid-drag does not end the session", () => {
    const view = mount();
    liftA();
    view.rerender({ showA: false });
    expect(screen.queryByTestId("slot-a")).toBeNull();
    move(150, 250);
    expect(seam.hover).toHaveBeenCalledTimes(1);
    release(150, 250);
    expect(seam.drop).toHaveBeenCalledWith(targetFor({ x: 150, y: 250 }));
    expect(seam.cancel).not.toHaveBeenCalled();
  });

  it("B13 slot unmount under the threshold: the lift still shows the press-time box", () => {
    const view = mount();
    press();
    view.rerender({ showA: false });
    expect(screen.queryByTestId("slot-a")).toBeNull();
    // A browser measures a node outside the document as an empty box.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        return rectOf(this.isConnected ? this.dataset.rect : undefined);
      },
    );
    move(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    const box = ghostBox();
    expect(ghostVisible()).toBe(true);
    expect(box.style.width).toBe("280px");
    expect(box.style.height).toBe("70px");
    expect(box.style.transform).toBe("translate3d(290px, 385px, 0px)");
    release(300, 400);
    expect(seam.drop).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "hides",
      (view: ReturnType<typeof mount>) => view.rerender({ mode: "hidden" }),
    ],
    ["unmounts", (view: ReturnType<typeof mount>) => view.unmount()],
  ])(
    "B10 a press under the threshold when the panel %s calls nothing and leaves no listener",
    (_name, finish) => {
      const view = mount();
      press();
      move(PRESS.x + 2, PRESS.y + 2);
      finish(view);
      move(300, 400);
      release(300, 400);
      expect(seam.lift).not.toHaveBeenCalled();
      noSeamCalls();
      expect(added.length).toBeGreaterThan(0);
      expect(unmatched(added, removed)).toEqual([]);
      expect(documentAdded).toEqual([]);
      expect(frames.size).toBe(0);
    },
  );

  it("B18 lost release: a move with the primary up ends a press silently", () => {
    mount();
    press();
    move(PRESS.x + 20, PRESS.y, { buttons: 0 });
    expect(seam.lift).not.toHaveBeenCalled();
    expect(unmatched(added, removed)).toEqual([]);
    move(300, 400);
    release(300, 400);
    expect(seam.lift).not.toHaveBeenCalled();
    noSeamCalls();
  });

  it("B18 lost release: a move with the primary up cancels a lifted gesture once", () => {
    mount();
    liftA();
    move(310, 410, { buttons: 0 });
    expect(seam.cancel).toHaveBeenCalledTimes(1);
    expect(seam.hover).not.toHaveBeenCalled();
    expect(ghostVisible()).toBe(false);
    expect(frames.size).toBe(0);
    expect(unmatched(added, removed)).toEqual([]);
    move(320, 420);
    release(320, 420);
    expect(seam.drop).not.toHaveBeenCalled();
    expect(seam.cancel).toHaveBeenCalledTimes(1);
  });
});

/** The real seam slot around one card that also portals a popover to the
 *  body, as a draft card's notes and an issue card's peek do. */
function PortalShell() {
  return (
    <Provider>
      <BoardDragCardSlot itemId="a" disabled={false}>
        <button type="button" data-testid="card-a">
          a
        </button>
        {createPortal(
          <div data-testid="popover">
            <span data-testid="popover-text">notes</span>
          </div>,
          document.body,
        )}
      </BoardDragCardSlot>
    </Provider>
  );
}

describe("pointer engine: the seam's slot", () => {
  it("a press inside a portalled child: no lift, no seam call, no listener", () => {
    render(<PortalShell />);
    resetListenerLog();
    expect(
      fireEvent.pointerDown(
        screen.getByTestId("popover-text"),
        pointerInit(PRESS.x, PRESS.y),
      ),
    ).toBe(true);
    expect(added).toEqual([]);
    move(300, 400);
    release(300, 400);
    expect(seam.lift).not.toHaveBeenCalled();
    noSeamCalls();
    expect(unmatched(added, removed)).toEqual([]);

    // The card itself still lifts through the same slot.
    fireEvent.pointerDown(
      screen.getByTestId("card-a"),
      pointerInit(PRESS.x, PRESS.y),
    );
    move(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    release(300, 400);
    expect(seam.drop).toHaveBeenCalledTimes(1);
    expect(unmatched(added, removed)).toEqual([]);
  });
});

describe("pointer engine: addendum rules", () => {
  it("C1 window blur: an element blur during the press does not end it", () => {
    mount();
    screen.getByTestId("other").focus();
    press();
    // The press moves focus to the card, so the other element blurs.
    screen.getByTestId("card-a").focus();
    move(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    release(300, 400);
  });

  it("C1 window blur: the window losing focus ends a press, not a lifted gesture", () => {
    mount();
    press();
    windowBlur();
    move(300, 400);
    expect(seam.lift).not.toHaveBeenCalled();
    liftA();
    windowBlur();
    move(150, 250);
    expect(seam.hover).toHaveBeenCalledTimes(1);
    expect(seam.cancel).not.toHaveBeenCalled();
  });

  it("C2 a pointerdown during a live gesture ends it; a card press starts afresh", () => {
    mount();
    liftA();
    fireEvent.pointerDown(
      document.body,
      pointerInit(50, 50, { pointerId: 2, pointerType: "touch" }),
    );
    expect(seam.cancel).toHaveBeenCalledTimes(1);
    release(300, 400);
    expect(seam.drop).not.toHaveBeenCalled();
    expect(ghostVisible()).toBe(false);
    expect(unmatched(added, removed)).toEqual([]);

    // A stale press is ended silently and the new card press is handled fresh.
    clearSeamCalls();
    press("a");
    press("b");
    move(300, 400);
    expect(seam.lift).toHaveBeenCalledTimes(1);
    expect(seam.lift.mock.calls[0][0].itemId).toBe("b");
    expect(seam.cancel).not.toHaveBeenCalled();
    release(300, 400);
    expect(seam.drop).toHaveBeenCalledTimes(1);
  });

  it("C4 hover cadence: every lifted frame re-hovers the still pointer's target", () => {
    mount();
    liftA();
    move(150, 250);
    seam.hover.mockClear();
    runFrame(1000);
    runFrame(1016);
    const still = targetFor({ x: 150, y: 250 });
    expect(seam.hover.mock.calls.map((c) => c[0])).toEqual([still, still]);
  });

  it("C4 hover cadence: rows that change under a still pointer are hovered on the next frame", () => {
    mount();
    liftA();
    move(150, 250);
    runFrame(1000);
    // The board re-hit-tests differently at the same point: its rows moved.
    const moved = { columnId: "c1", beforeId: "inserted" };
    seam.targetAt.mockImplementation(() => moved);
    seam.hover.mockClear();
    runFrame(1016);
    expect(seam.targetAt).toHaveBeenLastCalledWith({ x: 150, y: 250 });
    expect(seam.hover).toHaveBeenCalledTimes(1);
    expect(seam.hover).toHaveBeenCalledWith(moved);
  });

  it("C8 hidden panel through TabPanel: listeners, frame and capture all released, nothing reported", () => {
    const view = mount();
    liftA();
    expect(added.map((a) => a.type).sort()).toEqual([...GESTURE_TYPES].sort());
    const pending = [...frames.keys()];
    view.rerender({ mode: "hidden" });
    expect(unmatched(added, removed)).toEqual([]);
    expect(documentAdded).toEqual([]);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(pending[0]);
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(seam.cancel).not.toHaveBeenCalled();
  });
});

describe("pointer engine: autoscroll", () => {
  it("B14 autoscroll: a column scrolls toward the near edge and the target is re-hovered", () => {
    mount();
    liftA();
    runFrame(1000);
    for (const [y, sign] of [
      [495, 1],
      [520, 1],
      [5, -1],
      [250, 0],
    ] as const) {
      column.scrollTop = 100;
      move(150, y);
      seam.hover.mockClear();
      runFrame(2000 + y * 100);
      runFrame(2016 + y * 100);
      expect(Math.sign(column.scrollTop - 100)).toBe(sign);
      expect(seam.hover).toHaveBeenLastCalledWith(targetFor({ x: 150, y }));
    }
  });

  it("B15 autoscroll: the board scrolls sideways within 64 px of its edge", () => {
    mount();
    liftA();
    runFrame(1000);
    for (const [x, sign] of [
      [990, 1],
      [10, -1],
      [500, 0],
    ] as const) {
      board.scrollLeft = 100;
      move(x, 250);
      runFrame(2000 + x * 100);
      runFrame(2016 + x * 100);
      expect(Math.sign(board.scrollLeft - 100)).toBe(sign);
    }
  });

  it("B16 autoscroll: slow speeds still move and the loop ends with the session", () => {
    mount();
    liftA();
    // One pixel inside the bottom zone: well under a pixel per frame.
    move(150, 500 - 48 + 1);
    let ts = 1000;
    runFrame(ts);
    for (let i = 0; i < 5; i += 1) {
      ts += 16;
      runFrame(ts);
    }
    expect(column.scrollTop).toBeGreaterThan(100);
    expect(Number.isInteger(column.scrollTop)).toBe(true);
    // The first frame records only its time: no step spans the lift.
    expect(seam.boardScrollEl).toHaveBeenCalled();

    const [[id, stale]] = [...frames];
    release(150, 453);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(id);
    expect(frames.size).toBe(0);
    const before = column.scrollTop;
    seam.hover.mockClear();
    stale(ts + 16);
    expect(column.scrollTop).toBe(before);
    expect(seam.hover).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("B16 autoscroll: the first frame never steps", () => {
    mount();
    liftA();
    move(150, 520);
    runFrame(1000);
    expect(column.scrollTop).toBe(100);
    runFrame(1016);
    expect(column.scrollTop).toBeGreaterThan(100);
  });
});

describe("pointer engine: listener plan", () => {
  const endings: [string, () => void][] = [
    ["release", () => release(300, 400)],
    ["seam abort (Escape)", () => aborts[aborts.length - 1]()],
    [
      "window blur, then the seam's abort",
      () => {
        windowBlur();
        aborts[aborts.length - 1]();
      },
    ],
    [
      "lost capture",
      () => fireEvent.lostPointerCapture(layer(), pointerInit(300, 400)),
    ],
    [
      "pointercancel",
      () => fireEvent.pointerCancel(document.body, pointerInit(300, 400)),
    ],
  ];

  it.each(endings)(
    "B17 listener plan: every window listener added for a gesture is removed at its end (lifted, %s)",
    (_name, finish) => {
      mount();
      liftA();
      finish();
      expect(added.length).toBeGreaterThan(0);
      for (const entry of added) expect(GESTURE_TYPES).toContain(entry.type);
      expect(unmatched(added, removed)).toEqual([]);
      expect(documentAdded).toEqual([]);
    },
  );

  it.each([
    ["sub-threshold release", () => release(PRESS.x, PRESS.y)],
    ["pre-lift window blur", () => windowBlur()],
    [
      "pre-lift second button",
      () => move(PRESS.x + 1, PRESS.y, { buttons: 3 }),
    ],
  ])(
    "B17 listener plan: every window listener added for a gesture is removed at its end (pressed, %s)",
    (_name, finish) => {
      mount();
      press();
      finish();
      expect(added.length).toBeGreaterThan(0);
      expect(unmatched(added, removed)).toEqual([]);
      move(300, 400);
      expect(seam.lift).not.toHaveBeenCalled();
    },
  );
});
