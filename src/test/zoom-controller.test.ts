import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAction,
  hasLiveHandler,
  registerHandler,
} from "@/lib/hotkeys/handler-registry";
import { queryClient } from "@/lib/query-client";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { toastErrorWithNote } from "@/lib/toast";
import { minWindowSizeFor, ZOOM_STEPS } from "@/lib/zoom/steps";
import {
  __resetZoomForTests,
  __zoomWorkAreaForTests,
  getZoomState,
  initZoom,
  resetZoom,
  setZoomLevel,
  stepZoom,
} from "@/lib/zoom/zoom";
import zoomSource from "@/lib/zoom/zoom.ts?raw";

// The Tauri window/webview modules bypass the app transport seam, so each is
// mocked here; dpi stays real (LogicalSize is a plain value class).
const tauri = vi.hoisted(() => {
  const size = (width: number, height: number) => ({ width, height });
  return {
    size,
    setZoom: vi.fn(),
    setMinSize: vi.fn(),
    setSize: vi.fn(),
    innerSize: vi.fn(),
    outerSize: vi.fn(),
    outerPosition: vi.fn(),
    setPosition: vi.fn(),
    scaleFactor: vi.fn(),
    isMinimized: vi.fn(),
    isMaximized: vi.fn(),
    isFullscreen: vi.fn(),
    onMoved: vi.fn(),
    onResized: vi.fn(),
    onScaleChanged: vi.fn(),
    onFocusChanged: vi.fn(),
    currentMonitor: vi.fn(),
    moved: [] as Array<() => void>,
    // The move and resize callbacks apart, as well as in `moved`.
    windowMoved: [] as Array<() => void>,
    resized: [] as Array<() => void>,
    scaled: [] as Array<() => void>,
    focused: [] as Array<(event: { payload: boolean }) => void>,
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: tauri.setZoom }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => tauri,
  currentMonitor: () => tauri.currentMonitor(),
}));
// The toast spies forward to the real sonner while a test sets `sonner.real`,
// so its store's update-vs-new decisions are exercised against a real Toaster.
const sonner = vi.hoisted(() => ({
  real: null as null | typeof import("sonner"),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn((message: string, data?: object) =>
      sonner.real?.toast(message, data),
    ),
    {
      error: vi.fn(),
      success: vi.fn(),
      dismiss: vi.fn((id?: string) => sonner.real?.toast.dismiss(id)),
    },
  ),
}));
vi.mock("@/lib/toast", () => ({ toastErrorWithNote: vi.fn() }));
// Spied, not replaced: dispatch still reads the real registry.
vi.mock("@/lib/hotkeys/handler-registry", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/hotkeys/handler-registry")>();
  return { ...real, registerHandler: vi.fn(real.registerHandler) };
});
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsPatch: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains the controller's promise chains (no timers involved). */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const monitor = (width: number, height: number, scaleFactor = 1) => ({
  name: null,
  size: tauri.size(width, height),
  position: { x: 0, y: 0 },
  workArea: { position: { x: 0, y: 0 }, size: tauri.size(width, height) },
  scaleFactor,
});

const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...patch,
});

const cachedZoom = () =>
  queryClient.getQueryData<AppSettings>(settingsKeys.settings)?.zoom;

function wheel(deltaY: number, init: WheelEventInit = {}) {
  const e = new WheelEvent("wheel", {
    deltaY,
    deltaMode: 0,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.body.dispatchEvent(e);
  return e;
}

function key(init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.body.dispatchEvent(e);
  return e;
}

const level = () => getZoomState().level;
/** The focus callbacks as `pass` callbacks, each firing `payload`. */
const focusEvents = (payload: boolean) =>
  tauri.focused.map((cb) => () => cb({ payload }));
const minSizes = () =>
  tauri.setMinSize.mock.calls.map(([s]) => [s.width, s.height]);

async function start() {
  initZoom();
  await flush();
}

/** Windows' set_min_inner_size grows a window below the new minimum inside the
 *  call; later size reads see it. `gate` holds the call open after the grow. */
function growNatively(start: { width: number; height: number }) {
  const native = { size: start, gate: Promise.resolve() };
  tauri.innerSize.mockImplementation(async () => native.size);
  tauri.outerSize.mockImplementation(async () =>
    tauri.size(native.size.width + 16, native.size.height + 39),
  );
  tauri.setMinSize.mockImplementation(
    async (min: { width: number; height: number }) => {
      native.size = tauri.size(
        Math.max(native.size.width, min.width),
        Math.max(native.size.height, min.height),
      );
      await native.gate;
    },
  );
  return native;
}

/** Fires the given window callbacks and drains the debounced monitor pass. */
async function pass(callbacks = tauri.moved) {
  for (const cb of callbacks) cb();
  await vi.advanceTimersByTimeAsync(200);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  tauri.moved = [];
  tauri.windowMoved = [];
  tauri.resized = [];
  tauri.scaled = [];
  tauri.focused = [];
  tauri.setZoom.mockResolvedValue(undefined);
  tauri.setMinSize.mockResolvedValue(undefined);
  tauri.setSize.mockResolvedValue(undefined);
  tauri.innerSize.mockResolvedValue(tauri.size(1600, 1000));
  tauri.outerSize.mockResolvedValue(tauri.size(1616, 1039));
  tauri.outerPosition.mockResolvedValue({ x: 0, y: 0 });
  tauri.setPosition.mockResolvedValue(undefined);
  tauri.scaleFactor.mockResolvedValue(1);
  tauri.isMinimized.mockResolvedValue(false);
  tauri.isMaximized.mockResolvedValue(false);
  tauri.isFullscreen.mockResolvedValue(false);
  // `moved` collects the move and resize callbacks, which both re-evaluate.
  tauri.onMoved.mockImplementation(async (cb: () => void) => {
    tauri.moved.push(cb);
    tauri.windowMoved.push(cb);
    return () => undefined;
  });
  tauri.onResized.mockImplementation(async (cb: () => void) => {
    tauri.moved.push(cb);
    tauri.resized.push(cb);
    return () => undefined;
  });
  tauri.onScaleChanged.mockImplementation(async (cb: () => void) => {
    tauri.scaled.push(cb);
    return () => undefined;
  });
  tauri.onFocusChanged.mockImplementation(
    async (cb: (event: { payload: boolean }) => void) => {
      tauri.focused.push(cb);
      return () => undefined;
    },
  );
  tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(saveSettingsPatch).mockImplementation(async (patch) =>
    settings(patch),
  );
  queryClient.setQueryData(settingsKeys.settings, settings());
});

afterEach(() => {
  __resetZoomForTests();
  queryClient.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("zoom actions", () => {
  it("registers the three handlers app-wide, once, and unregisters on reset", async () => {
    await start();
    initZoom();
    await flush();
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(registerHandler).toHaveBeenCalledTimes(3);
    for (const listen of [
      tauri.onMoved,
      tauri.onResized,
      tauri.onScaleChanged,
      tauri.onFocusChanged,
    ]) {
      expect(listen).toHaveBeenCalledTimes(1);
    }
    expect(hasLiveHandler("app-zoom-in")).toBe(true);
    dispatchAction("app-zoom-in");
    expect(level()).toBe(1.1);
    dispatchAction("app-zoom-reset");
    expect(level()).toBe(1);
    dispatchAction("app-zoom-out");
    expect(level()).toBe(0.9);
    // A doubled init would step twice on one wheel notch.
    wheel(-100);
    expect(level()).toBe(1);
    __resetZoomForTests();
    expect(hasLiveHandler("app-zoom-in")).toBe(false);
  });

  it("starts without a focus listener API", async () => {
    const onFocusChanged = tauri.onFocusChanged;
    Reflect.deleteProperty(tauri, "onFocusChanged");
    try {
      tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
      await start();
      expect(getZoomState().max).toBe(1.25);
      expect(tauri.moved).toHaveLength(2);
      dispatchAction("app-zoom-in");
      expect(level()).toBe(1.1);
    } finally {
      tauri.onFocusChanged = onFocusChanged;
    }
  });
});

describe("wheel", () => {
  it("steps on ctrl+wheel and leaves a plain wheel alone", async () => {
    await start();
    const plain = wheel(-100, { ctrlKey: false });
    expect(plain.defaultPrevented).toBe(false);
    expect(level()).toBe(1);
    const zoomIn = wheel(-100);
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(level()).toBe(1.1);
    wheel(100, { ctrlKey: false, metaKey: true });
    expect(level()).toBe(1);
  });

  it("accumulates pixel deltas to the threshold, one step per event at most", async () => {
    await start();
    wheel(-20);
    wheel(-20);
    expect(level()).toBe(1);
    wheel(-20);
    expect(level()).toBe(1.1);
    // A full notch is exactly one step, never two.
    wheel(-100);
    expect(level()).toBe(1.25);
    // A 100/zoom notch at 200% sits exactly on the threshold and still steps.
    wheel(-50);
    expect(level()).toBe(1.5);
  });

  it("pins the 50 px threshold", async () => {
    await start();
    wheel(-49);
    expect(level()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    wheel(50);
    expect(level()).toBe(0.9);
  });

  it("steps back exactly once on a reversal", async () => {
    await start();
    wheel(-100);
    wheel(-100);
    wheel(-100);
    expect(level()).toBe(1.5);
    wheel(100);
    expect(level()).toBe(1.25);
    // A partial burst one way doesn't eat into a press the other way.
    wheel(-40);
    wheel(50);
    expect(level()).toBe(1.1);
  });

  it("drops the pixel remainder once a pixel step fires", async () => {
    await start();
    wheel(-60);
    wheel(-40);
    expect(level()).toBe(1.1);
  });

  it("steps once per line- or page-mode event", async () => {
    await start();
    wheel(-3, { deltaMode: 1 });
    expect(level()).toBe(1.1);
    wheel(-3, { deltaMode: 1 });
    expect(level()).toBe(1.25);
    wheel(3, { deltaMode: 1 });
    expect(level()).toBe(1.1);
    wheel(-1, { deltaMode: 2 });
    expect(level()).toBe(1.25);
  });

  it("drops the pixel remainder when a line-mode step fires", async () => {
    await start();
    wheel(-40);
    wheel(-1, { deltaMode: 1 });
    expect(level()).toBe(1.1);
    wheel(-10);
    expect(level()).toBe(1.1);
  });

  it("zooms through a target that stops propagation", async () => {
    await start();
    const box = document.createElement("div");
    document.body.append(box);
    box.addEventListener("wheel", (e) => e.stopPropagation());
    const e = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(e);
    box.remove();
    expect(e.defaultPrevented).toBe(true);
    expect(level()).toBe(1.1);
  });

  it("drops the remainder after an idle gap", async () => {
    await start();
    wheel(-30);
    await vi.advanceTimersByTimeAsync(300);
    wheel(-30);
    expect(level()).toBe(1);
    // Negative control: the same pair without the gap steps.
    wheel(-30);
    expect(level()).toBe(1.1);
  });

  it("preventDefaults a ctrl+wheel at the boundary too", async () => {
    await start();
    setZoomLevel(2, "settings");
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(level()).toBe(2);
  });
});

describe("wheel over a multi-select list", () => {
  /** Stubs `el` as a box with these scroll and client sizes and `overflow` on
   *  both axes unless `overflowX`/`overflowY` say otherwise; jsdom lays
   *  nothing out. */
  function stubBox(
    el: HTMLElement,
    {
      scrollHeight = 0,
      clientHeight = 0,
      scrollWidth = 0,
      clientWidth = 0,
      overflow = "auto",
      overflowX = overflow,
      overflowY = overflow,
    }: {
      scrollHeight?: number;
      clientHeight?: number;
      scrollWidth?: number;
      clientWidth?: number;
      overflow?: string;
      overflowX?: string;
      overflowY?: string;
    },
  ) {
    el.style.overflowX = overflowX;
    el.style.overflowY = overflowY;
    const offsets = { top: 0, left: 0 };
    Object.defineProperties(el, {
      scrollHeight: { value: scrollHeight },
      clientHeight: { value: clientHeight },
      scrollWidth: { value: scrollWidth },
      clientWidth: { value: clientWidth },
      scrollTop: {
        get: () => offsets.top,
        set: (v: number) => {
          offsets.top = v;
        },
      },
      scrollLeft: {
        get: () => offsets.left,
        set: (v: number) => {
          offsets.left = v;
        },
      },
    });
    return el;
  }

  const div = (attribute?: string, value = "") => {
    const el = document.createElement("div");
    if (attribute) el.setAttribute(attribute, value);
    return el;
  };

  /** The production shape: the marked element is the scroller, 200 px tall
   *  over 2000 px, its rows direct children. */
  function markedScroller(attribute: string, value: string) {
    const list = stubBox(div(attribute, value), {
      scrollHeight: 2000,
      clientHeight: 200,
    });
    const row = div();
    list.append(row);
    document.body.append(list);
    return { list, row };
  }

  function wheelAt(target: EventTarget, deltaY: number, init = {}) {
    const e = new WheelEvent("wheel", {
      deltaY,
      deltaMode: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(e);
    return e;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("scrolls a marked scroller by the converted delta instead of zooming", async () => {
    await start();
    const zooms = tauri.setZoom.mock.calls.length;
    for (const [attribute, value] of [
      ["aria-multiselectable", "true"],
      ["data-multiselect", ""],
    ]) {
      const { list, row } = markedScroller(attribute, value);
      // From a row and from the list itself.
      for (const target of [row, list]) {
        const label = `${attribute} from ${target === row ? "a row" : "the list"}`;
        list.scrollTop = 500;
        expect(wheelAt(target, 30).defaultPrevented, label).toBe(true);
        expect(list.scrollTop, label).toBe(530);
        wheelAt(target, 2, { deltaMode: 1 });
        expect(list.scrollTop, label).toBe(530 + 2 * 16);
        wheelAt(target, -1, { deltaMode: 2, ctrlKey: false, metaKey: true });
        expect(list.scrollTop, label).toBe(530 + 2 * 16 - 200);
      }
      document.body.replaceChildren();
    }
    expect(tauri.setZoom).toHaveBeenCalledTimes(zooms);
    expect(level()).toBe(1);
  });

  it("scrolls an unmarked scroller nested in a marked list", async () => {
    await start();
    const list = div("aria-multiselectable", "true");
    const scroller = stubBox(div(), { scrollHeight: 2000, clientHeight: 200 });
    const row = div();
    scroller.append(row);
    list.append(scroller);
    document.body.append(list);
    wheelAt(row, 30);
    expect(scroller.scrollTop).toBe(30);
    expect(level()).toBe(1);
  });

  it("skips a clipped box that doesn't scroll on its way to the scroller", async () => {
    // A line-clamped title overflows its box under overflow: hidden.
    await start();
    const { list } = markedScroller("aria-multiselectable", "true");
    const clamped = stubBox(div(), {
      scrollHeight: 40,
      clientHeight: 20,
      overflow: "hidden",
    });
    const text = div();
    clamped.append(text);
    list.append(clamped);
    wheelAt(text, 30);
    expect(clamped.scrollTop).toBe(0);
    expect(list.scrollTop).toBe(30);
  });

  it("caps each step at the scroller's visible size", async () => {
    await start();
    const list = stubBox(div("data-multiselect"), {
      scrollHeight: 2000,
      clientHeight: 40,
    });
    document.body.append(list);
    list.scrollTop = 500;
    wheelAt(list, 100);
    expect(list.scrollTop).toBe(540);
    wheelAt(list, -10, { deltaMode: 1 });
    expect(list.scrollTop).toBe(500);
  });

  it("scrolls a marked grid sideways on a horizontal delta", async () => {
    await start();
    const grid = stubBox(div("aria-multiselectable", "true"), {
      scrollHeight: 2000,
      clientHeight: 200,
      scrollWidth: 3000,
      clientWidth: 300,
    });
    const cell = div();
    grid.append(cell);
    document.body.append(grid);
    wheelAt(cell, 0, { deltaX: 50 });
    expect([grid.scrollLeft, grid.scrollTop]).toEqual([50, 0]);
    wheelAt(cell, 0, { deltaX: 1, deltaMode: 1 });
    expect(grid.scrollLeft).toBe(50 + 16);
    wheelAt(cell, 0, { deltaX: -1, deltaMode: 2 });
    expect(grid.scrollLeft).toBe(50 + 16 - 300);
    // A vertical delta leaves the horizontal offset alone.
    grid.scrollLeft = 100;
    wheelAt(cell, 30);
    expect([grid.scrollLeft, grid.scrollTop]).toEqual([100, 30]);
    // A diagonal delta scrolls both axes from one event.
    wheelAt(cell, 30, { deltaX: 50 });
    expect([grid.scrollLeft, grid.scrollTop]).toEqual([150, 60]);
    expect(level()).toBe(1);
  });

  it("scrolls a marked grid that overflows only sideways", async () => {
    await start();
    const grid = stubBox(div("aria-multiselectable", "true"), {
      scrollHeight: 150,
      clientHeight: 150,
      scrollWidth: 3000,
      clientWidth: 900,
    });
    const cell = div();
    grid.append(cell);
    document.body.append(grid);
    wheelAt(cell, 0, { deltaX: 50 });
    expect([grid.scrollLeft, grid.scrollTop]).toEqual([50, 0]);
  });

  it("takes each axis on the nearest box that scrolls on it", async () => {
    // The grid scrolls only sideways; the box inside it only vertically.
    await start();
    const grid = stubBox(div("aria-multiselectable", "true"), {
      scrollHeight: 2000,
      clientHeight: 200,
      scrollWidth: 3000,
      clientWidth: 300,
      overflowX: "auto",
      overflowY: "hidden",
    });
    const inner = stubBox(div(), {
      scrollHeight: 2000,
      clientHeight: 200,
      scrollWidth: 200,
      clientWidth: 200,
    });
    const cell = div();
    inner.append(cell);
    grid.append(inner);
    document.body.append(grid);
    wheelAt(cell, 30, { deltaX: 50 });
    expect([grid.scrollLeft, inner.scrollTop, inner.scrollLeft]).toEqual([
      50, 30, 0,
    ]);
    expect(grid.scrollTop).toBe(0);
  });

  it("leaves the zoom accumulation alone over a list", async () => {
    await start();
    const { row } = markedScroller("data-multiselect", "");
    wheel(-30);
    wheelAt(row, -40);
    // Outside the list, the 30 px before it still needs 20 more.
    wheel(-10);
    expect(level()).toBe(1);
    wheel(-10);
    expect(level()).toBe(1.1);
  });

  it("stops at a marked list with nothing to scroll: no scroll above it, no zoom", async () => {
    await start();
    const ancestor = stubBox(div(), { scrollHeight: 2000, clientHeight: 200 });
    const list = stubBox(div("aria-multiselectable", "true"), {
      scrollHeight: 200,
      clientHeight: 200,
    });
    const row = div();
    list.append(row);
    ancestor.append(list);
    document.body.append(ancestor);
    expect(wheelAt(row, -120).defaultPrevented).toBe(true);
    expect([list.scrollTop, ancestor.scrollTop]).toEqual([0, 0]);
    expect(level()).toBe(1);
  });

  it("still zooms outside a marked list, and from a non-element target", async () => {
    await start();
    markedScroller("aria-multiselectable", "true");
    const outside = div();
    document.body.append(outside);
    wheelAt(outside, -60);
    expect(level()).toBe(1.1);
    // NEGATIVE CONTROL: a list not marked multi-select zooms too.
    const plain = div("aria-multiselectable", "false");
    document.body.append(plain);
    wheelAt(plain, -60);
    expect(level()).toBe(1.25);
    wheelAt(document, -60);
    expect(level()).toBe(1.5);
  });
});

describe("alias keys", () => {
  it("zoom in on mod+shift++ and mod++ under the default binding", async () => {
    await start();
    expect(
      key({ key: "+", ctrlKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(true);
    expect(level()).toBe(1.1);
    key({ key: "+", ctrlKey: true });
    expect(level()).toBe(1.25);
    // Negative control: a bare "+" is typing, not an alias.
    expect(key({ key: "+" }).defaultPrevented).toBe(false);
    expect(level()).toBe(1.25);
  });

  it("go dead once zoom-in is rebound away from mod+=", async () => {
    await start();
    queryClient.setQueryData(
      settingsKeys.settings,
      settings({ hotkeys: { "app-zoom-in": "mod+shift+8" } }),
    );
    const e = key({ key: "+", ctrlKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(level()).toBe(1);
  });

  it("yield to an action bound to the alias itself", async () => {
    await start();
    queryClient.setQueryData(
      settingsKeys.settings,
      settings({ hotkeys: { "open-settings": "mod++" } }),
    );
    expect(key({ key: "+", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(level()).toBe(1);
    // The other alias is still free.
    key({ key: "+", ctrlKey: true, shiftKey: true });
    expect(level()).toBe(1.1);
  });

  it("skip repeats and already-consumed presses", async () => {
    await start();
    key({ key: "+", ctrlKey: true, repeat: true });
    expect(level()).toBe(1);
    const consume = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", consume, { capture: true });
    key({ key: "+", ctrlKey: true });
    window.removeEventListener("keydown", consume, { capture: true });
    expect(level()).toBe(1);
    key({ key: "+", ctrlKey: true });
    expect(level()).toBe(1.1);
  });
});

describe("window minimum size", () => {
  it("raises the minimum with the zoom and restores it at 100%", async () => {
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([710, 625]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    resetZoom("action");
    await flush();
    expect(minSizes().at(-1)).toEqual([640, 600]);
  });

  it("grows a window below the new minimum to exactly the minimum", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown.width, grown.height]).toEqual([710, 625]);
  });

  it("converts physical to logical before comparing", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(1050, 900));
    tauri.outerSize.mockResolvedValue(tauri.size(1074, 958));
    tauri.scaleFactor.mockResolvedValue(1.5);
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown.width, grown.height]).toEqual([710, 625]);
  });

  it("never shrinks a dimension already above the minimum", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(2000, 600));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown.width, grown.height]).toEqual([2000, 625]);
  });

  it("moves a grown window up into the work area, keeping its x", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 420 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    setZoomLevel(1.25, "action");
    await flush();
    // 710×625 inner plus the 16×39 frame ends at 420 + 664 > 1040.
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved.type, moved.x, moved.y]).toEqual(["Physical", 100, 376]);
  });

  it("moves to whole physical pixels inside the area at a fractional scale", async () => {
    tauri.scaleFactor.mockResolvedValue(1.25);
    tauri.innerSize.mockResolvedValue(tauri.size(875, 750));
    tauri.outerSize.mockResolvedValue(tauri.size(895, 799));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 600 });
    tauri.currentMonitor.mockResolvedValue(monitor(2400, 1300, 1.25));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    // tao gives the 710×625 minimum 888×781 physical px, 908×830 with the
    // frame; the logical rect, 907.5×830.25, would land at y 469.75.
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect(Number.isInteger(moved.x) && Number.isInteger(moved.y)).toBe(true);
    expect([moved.x, moved.y]).toEqual([100, 470]);
    expect(moved.y + 830).toBe(1300);
  });

  it("never pulls a window back from another monitor with a stale work area", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    // Dragged onto a monitor to the right; no pass has re-read the area yet.
    tauri.outerPosition.mockResolvedValue({ x: 2500, y: 900 });
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    // A snapped corner just outside the area still counts as inside.
    tauri.outerPosition.mockResolvedValue({ x: -7, y: 300 });
    setZoomLevel(1.5, "action");
    await flush();
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved.x, moved.y]).toEqual([0, 251]);
  });

  it("grows at an unchanged level once a pass first learns the work area", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown.width, grown.height]).toEqual([710, 625]);
    // Negative control: once the grow landed, a further pass sends nothing.
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    const mins = tauri.setMinSize.mock.calls.length;
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(tauri.setMinSize).toHaveBeenCalledTimes(mins);
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
  });

  it("retries a minimum whose setMinSize failed", async () => {
    await start();
    tauri.setMinSize.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    // No retry inside the run: the next request carries it.
    expect(minSizes()).toEqual([[710, 625]]);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(minSizes().slice(-2)).toEqual([
      [710, 625],
      [710, 625],
    ]);
  });

  it("moves left as well as up when both edges overflow", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.outerPosition.mockResolvedValue({ x: 1500, y: 100 });
    tauri.scaleFactor.mockResolvedValue(1);
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 700));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    // The 726×664 outer rect fits at 1920 − 726 and 700 − 664.
    expect([moved.type, moved.x, moved.y]).toEqual(["Physical", 1194, 36]);
  });

  it("never moves a window that didn't grow", async () => {
    tauri.outerPosition.mockResolvedValue({ x: 3000, y: 2000 });
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  it("keeps an in-flight grow when a same-level pass lands during it", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    const answer = deferred<ReturnType<typeof monitor>>();
    tauri.currentMonitor.mockReturnValueOnce(answer.promise);
    await pass();
    const read = deferred<ReturnType<typeof tauri.size>>();
    tauri.innerSize.mockReturnValueOnce(read.promise);
    setZoomLevel(1.25, "action");
    await flush();
    answer.resolve(monitor(3840, 2160));
    await flush();
    read.resolve(tauri.size(700, 600));
    await flush();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    const [grown] = tauri.setSize.mock.calls[0];
    expect([grown.width, grown.height]).toEqual([710, 625]);
  });

  it("lands the newest minimum and grow after a rapid there-and-back", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    setZoomLevel(1.1, "action");
    setZoomLevel(1.25, "action");
    await flush();
    slow.resolve();
    await flush();
    expect(minSizes().at(-1)).toEqual([710, 625]);
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    const [grown] = tauri.setSize.mock.calls[0];
    expect([grown.width, grown.height]).toEqual([710, 625]);
  });

  it("retries a grow whose setSize failed on the next pass", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    tauri.setSize.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    await pass();
    expect(tauri.setSize).toHaveBeenCalledTimes(2);
    // Negative control: once it landed, a further pass sends nothing.
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    await pass();
    expect(tauri.setSize).toHaveBeenCalledTimes(2);
  });

  it("sends the minimum when the size read fails, and grows from a fresh read", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    tauri.innerSize.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([710, 625]);
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown?.width, grown?.height]).toEqual([710, 625]);
    // With the fresh read failing too, the grow waits for the next pass.
    tauri.innerSize
      .mockRejectedValueOnce(new Error("ipc"))
      .mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.5, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([852, 750]);
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    await pass();
    const [regrown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([regrown?.width, regrown?.height]).toEqual([852, 750]);
  });

  it("skips the explicit grow after a native one, and moves by the grown size", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 420 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    // A native grow inside set_min_inner_size: later size reads see the minimum.
    tauri.setMinSize.mockImplementation(async () => {
      tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    });
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("never grows for a level superseded during its setMinSize", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.5, "action");
    await flush();
    setZoomLevel(1, "action");
    await flush();
    slow.resolve();
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(minSizes().at(-1)).toEqual([640, 600]);
  });

  it("never grows for, or sets last, a level superseded during its size read", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    const read = deferred<ReturnType<typeof tauri.size>>();
    tauri.innerSize.mockReturnValueOnce(read.promise);
    setZoomLevel(1.5, "action");
    await flush();
    setZoomLevel(1, "action");
    await flush();
    read.resolve(tauri.size(700, 600));
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(minSizes()).not.toContainEqual([852, 750]);
  });

  it("never sets a minimum superseded during its window-state read", async () => {
    await start();
    const minimized = deferred<boolean>();
    tauri.isMinimized.mockReturnValueOnce(minimized.promise);
    setZoomLevel(1.5, "action");
    setZoomLevel(1, "action");
    await flush();
    minimized.resolve(false);
    await flush();
    // 100% is the minimum the window already has, so nothing goes out.
    expect(minSizes()).toEqual([]);
  });

  it("sends an overlapping same-level minimum once", async () => {
    await start();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    await pass();
    slow.resolve();
    await flush();
    expect(minSizes().filter(([w]) => w === 710)).toHaveLength(1);
  });

  it("counts a rejected window read in the first pass as its answer", async () => {
    for (const read of ["isMinimized", "isMaximized", "outerSize"] as const) {
      tauri[read].mockRejectedValueOnce(new Error("ipc"));
      await start();
      setZoomLevel(1.5, "action");
      await flush();
      expect(minSizes().at(-1), read).toEqual([852, 750]);
      __resetZoomForTests();
      vi.clearAllMocks();
    }
  });

  it("never raises past a 700x600 window while the display is unknown", async () => {
    localStorage.setItem("gd-zoom", "2");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 2 }));
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    expect(level()).toBe(2);
    for (const [w, h] of minSizes()) {
      expect(w <= 700 && h <= 600, String([w, h])).toBe(true);
    }
    // A raise the window already meets goes out.
    tauri.innerSize.mockResolvedValue(tauri.size(1600, 1000));
    setZoomLevel(1.5, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([852, 750]);
    // A change waits while the size can't be read, a lowering too: it could
    // grow a window a drag left below it. Read on the next pass, the window
    // meets 100%, so the lowering goes out.
    tauri.innerSize.mockRejectedValueOnce(new Error("ipc"));
    resetZoom("action");
    await flush();
    expect(minSizes().at(-1)).toEqual([852, 750]);
    await pass();
    expect(minSizes().at(-1)).toEqual([640, 600]);
    const sent = tauri.setMinSize.mock.calls.length;
    tauri.innerSize.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setMinSize).toHaveBeenCalledTimes(sent);
    expect(tauri.setSize).not.toHaveBeenCalled();
  });

  it("never counts an overtaken rejected first pass as the answer", async () => {
    const minimized = deferred<boolean>();
    tauri.isMinimized.mockReturnValueOnce(minimized.promise);
    await start();
    const answer = deferred<ReturnType<typeof monitor>>();
    tauri.currentMonitor.mockReturnValueOnce(answer.promise);
    await pass();
    minimized.reject(new Error("ipc"));
    await flush();
    setZoomLevel(1.5, "action");
    await flush();
    expect(tauri.setMinSize).not.toHaveBeenCalled();
    answer.resolve(monitor(3840, 2160));
    await flush();
    expect(minSizes().at(-1)).toEqual([852, 750]);
  });

  it("retries a failed move back on screen on the next pass", async () => {
    for (const read of ["setPosition", "outerPosition"] as const) {
      tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
      tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
      tauri.outerPosition.mockResolvedValue({ x: 100, y: 420 });
      tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
      await start();
      tauri[read].mockRejectedValueOnce(new Error("ipc"));
      setZoomLevel(1.25, "action");
      await flush();
      expect(tauri.setSize, read).toHaveBeenCalledTimes(1);
      // The grow landed; the move didn't.
      tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
      tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
      const moves = tauri.setPosition.mock.calls.length;
      await pass();
      expect(tauri.setSize, read).toHaveBeenCalledTimes(1);
      const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
      expect([moved?.x, moved?.y], read).toEqual([100, 376]);
      expect(tauri.setPosition, read).toHaveBeenCalledTimes(moves + 1);
      // Negative control: once it landed, a further pass moves nothing.
      await pass();
      expect(tauri.setPosition, read).toHaveBeenCalledTimes(moves + 1);
      __resetZoomForTests();
      vi.clearAllMocks();
    }
  });

  it("never lets a superseded maximized read forget the newer minimum", async () => {
    await start();
    const maximized = deferred<boolean>();
    tauri.isMaximized.mockReturnValueOnce(maximized.promise);
    setZoomLevel(1.25, "action");
    setZoomLevel(1.5, "action");
    await flush();
    // The run in flight holds the newer request until its read lands.
    expect(minSizes()).toEqual([]);
    maximized.resolve(true);
    await flush();
    expect(minSizes()).toEqual([[852, 750]]);
    await pass();
    expect(minSizes()).toEqual([[852, 750]]);
  });

  it("never lets a superseded failed read forget the newer minimum", async () => {
    await start();
    const maximized = deferred<boolean>();
    tauri.isMaximized.mockReturnValueOnce(maximized.promise);
    setZoomLevel(1.25, "action");
    setZoomLevel(1.5, "action");
    await flush();
    maximized.reject(new Error("ipc"));
    await flush();
    await pass();
    expect(minSizes().filter(([w]) => w === 852)).toHaveLength(1);
  });

  it("waits for the first monitor answer", async () => {
    const answer = deferred<ReturnType<typeof monitor>>();
    tauri.currentMonitor.mockReturnValueOnce(answer.promise);
    localStorage.setItem("gd-zoom", "1.5");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
    await start();
    expect(tauri.setZoom).toHaveBeenCalledWith(1.5);
    expect(tauri.setMinSize).not.toHaveBeenCalled();
    expect(tauri.setSize).not.toHaveBeenCalled();
    answer.resolve(monitor(3840, 2160));
    await flush();
    expect(minSizes().at(-1)).toEqual([852, 750]);
  });

  it("skips the min-size path while minimized, maximized or fullscreen", async () => {
    for (const flag of [
      "isMinimized",
      "isMaximized",
      "isFullscreen",
    ] as const) {
      tauri[flag].mockResolvedValue(true);
      await start();
      setZoomLevel(1.25, "action");
      await flush();
      expect(tauri.setMinSize, flag).not.toHaveBeenCalled();
      expect(tauri.setZoom, flag).toHaveBeenCalledWith(1.25);
      __resetZoomForTests();
      vi.clearAllMocks();
      tauri[flag].mockResolvedValue(false);
    }
  });
});

describe("geometry reconciler", () => {
  /** A 700×600 window just inside the bottom of a 1920×1040 area: a grow to
   *  125% pushes it 24 px past the edge, so the move lands at y 376. */
  async function startOnScreen() {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 400 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
  }

  it("never grows a window the user enlarged during setMinSize back to a stale size", async () => {
    await startOnScreen();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    // The user drags the window bigger while the call is pending.
    tauri.innerSize.mockResolvedValue(tauri.size(1000, 800));
    slow.resolve();
    await flush();
    for (const [size] of tauri.setSize.mock.calls) {
      expect(size.width >= 1000 && size.height >= 800, String(size)).toBe(true);
    }
    expect(tauri.setSize).not.toHaveBeenCalled();
  });

  it("holds an unknown-display raise when the window shrank after the first read", async () => {
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    // The first read sees room for 125%; by the second the user shrank it.
    tauri.innerSize
      .mockResolvedValueOnce(tauri.size(1600, 1000))
      .mockResolvedValue(tauri.size(700, 600));
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([]);
    // Negative control: a window that still meets it takes the raise.
    tauri.innerSize.mockResolvedValue(tauri.size(1600, 1000));
    setZoomLevel(1.5, "action");
    await flush();
    expect(minSizes()).toEqual([[852, 750]]);
  });

  it("re-sends the minimum after a failed setMinSize, even one equal to the last", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    const failed = Promise.reject(new Error("ipc"));
    failed.catch(() => undefined);
    native.gate = failed;
    setZoomLevel(1.25, "action");
    await flush();
    native.gate = Promise.resolve();
    dispatchAction("app-zoom-reset");
    await flush();
    expect(minSizes()).toEqual([
      [710, 625],
      [640, 600],
    ]);
  });

  it("never grows past the window on a display a failed pass left unknown", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    // The pass reads the monitor, then fails reading the frame.
    tauri.outerSize.mockRejectedValueOnce(new Error("ipc"));
    await pass();
    setZoomLevel(2, "action");
    await flush();
    expect(minSizes()).not.toContainEqual([1136, 1000]);
    expect(native.size).toEqual(tauri.size(700, 600));
  });

  it("never grows past the window on a display a null answer left unknown", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    tauri.currentMonitor.mockResolvedValue(null);
    await pass();
    setZoomLevel(2, "action");
    await flush();
    expect(minSizes()).not.toContainEqual([1136, 1000]);
    expect(native.size).toEqual(tauri.size(700, 600));
    // Negative control: the known display takes the same raise and grows.
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    await pass();
    expect(native.size).toEqual(tauri.size(1136, 1000));
  });

  /** A 200% reconcile holds its first size read while a newer pass lands an
   *  unknown display (`landUnknown` arms how), then the read answers 700×600. */
  async function unknownDuringFirstRead(landUnknown: () => void) {
    await startOnScreen();
    const read = deferred<ReturnType<typeof tauri.size>>();
    tauri.innerSize.mockReturnValueOnce(read.promise);
    setZoomLevel(2, "action");
    await flush();
    landUnknown();
    await pass();
    read.resolve(tauri.size(700, 600));
    await flush();
    expect(minSizes()).not.toContainEqual([1136, 1000]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
  }

  it("stops a run in flight once a newer pass fails, leaving the display unknown", async () => {
    // The pass reads the monitor, then fails measuring the frame.
    await unknownDuringFirstRead(() =>
      tauri.outerSize.mockRejectedValueOnce(new Error("ipc")),
    );
  });

  it("stops a run in flight once a newer pass answers no monitor", async () => {
    await unknownDuringFirstRead(() =>
      tauri.currentMonitor.mockResolvedValueOnce(null),
    );
  });

  it("defers the move back on screen when a pass leaves the display unknown during the grow", async () => {
    await startOnScreen();
    const grow = deferred<void>();
    tauri.setSize.mockReturnValueOnce(grow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    tauri.outerSize.mockRejectedValueOnce(new Error("ipc"));
    await pass();
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    grow.resolve();
    await flush();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    // The move stays owed: the next known pass makes it.
    await pass();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("defers the move back on screen, spending no try, when a pass leaves the display unknown during the position read", async () => {
    await startOnScreen();
    const position = deferred<{ x: number; y: number }>();
    tauri.outerPosition.mockReturnValueOnce(position.promise);
    setZoomLevel(1.25, "action");
    await flush();
    tauri.outerSize.mockRejectedValueOnce(new Error("ipc"));
    await pass();
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    position.resolve({ x: 100, y: 400 });
    await flush();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    // A failed move is the first try, so its retry still runs.
    tauri.outerPosition.mockRejectedValueOnce(new Error("ipc"));
    await pass();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    await pass();
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("grows a window a drag left below the accepted minimum on the next pass", async () => {
    // Zoomed from 175% to 200% mid-drag: the drag holds 1294×935 through the
    // grow, under the 1136×1000 minimum the window accepted.
    let size = tauri.size(1294, 935);
    tauri.innerSize.mockImplementation(async () => size);
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.setSize.mockImplementation(
      async (s: { width: number; height: number }) => {
        size = tauri.size(s.width, s.height);
      },
    );
    // The window stays where the drag left it, its bottom past the area's.
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 100 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1080));
    await start();
    setZoomLevel(1.75, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    tauri.setSize.mockImplementationOnce(async () => undefined);
    setZoomLevel(2, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([1136, 1000]);
    expect(size).toEqual(tauri.size(1294, 935));
    const sizes = tauri.setSize.mock.calls.length;
    const moves = tauri.setPosition.mock.calls.length;
    // An unknown display never grows it.
    tauri.currentMonitor.mockResolvedValueOnce(null);
    await pass();
    expect(tauri.setSize).toHaveBeenCalledTimes(sizes);
    await pass();
    const grows = tauri.setSize.mock.calls.slice(sizes);
    expect(grows.map(([s]) => [s.width, s.height])).toEqual([[1294, 1000]]);
    expect(tauri.setPosition).toHaveBeenCalledTimes(moves + 1);
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved.x, moved.y]).toEqual([100, 41]);
    // Negative control: meeting the minimum, the next pass writes nothing,
    // though the window still reads as overflowing the area.
    const writes = () =>
      [tauri.setMinSize, tauri.setSize, tauri.setPosition].map(
        (call) => call.mock.calls.length,
      );
    const before = writes();
    await pass();
    expect(writes()).toEqual(before);
  });

  /** One window at a fractional scale, its inner and outer size physical. */
  function physicalWindow(
    inner: { width: number; height: number },
    scale: number,
  ) {
    tauri.scaleFactor.mockResolvedValue(scale);
    tauri.innerSize.mockResolvedValue(tauri.size(inner.width, inner.height));
    tauri.outerSize.mockResolvedValue(
      tauri.size(inner.width + 20, inner.height + 49),
    );
    // Its bottom 30 px past the area's, its centre inside.
    tauri.outerPosition.mockResolvedValue({
      x: 0,
      y: 4000 - inner.height - 19,
    });
    tauri.currentMonitor.mockResolvedValue(monitor(5000, 4000, scale));
  }

  it("leaves a window at its rounded physical floor alone at a fractional scale", async () => {
    // tao floors the window at round(min × scale), half away from zero; read
    // back in logical px the floor sits a fraction under the minimum.
    for (const [zoom, scale, floor] of [
      [1.25, 1.25, [888, 781]],
      [1.75, 1.75, [1740, 1531]],
      [1.25, 2.25, [1598, 1406]],
    ] as const) {
      const label = `${zoom} at ${scale}`;
      physicalWindow(tauri.size(floor[0], floor[1]), scale);
      await start();
      setZoomLevel(zoom, "action");
      await flush();
      expect(minSizes(), label).toEqual([
        [minWindowSizeFor(zoom).width, minWindowSizeFor(zoom).height],
      ]);
      await pass();
      await pass();
      expect(tauri.setSize, label).not.toHaveBeenCalled();
      expect(tauri.setPosition, label).not.toHaveBeenCalled();
      __resetZoomForTests();
      vi.clearAllMocks();
      tauri.moved = [];
    }
  });

  it("grows a window one physical pixel under its floor at a fractional scale", async () => {
    // 994 × 1.75 is 1739.5, which rounds half away from zero to 1740.
    for (const [zoom, scale, inner, want] of [
      [1.25, 1.25, [888, 780], [888 / 1.25, 625]],
      [1.75, 1.75, [1739, 1531], [994, 1531 / 1.75]],
    ] as const) {
      const label = `${zoom} at ${scale}`;
      physicalWindow(tauri.size(inner[0], inner[1]), scale);
      await start();
      setZoomLevel(zoom, "action");
      await flush();
      // A meeting axis keeps its own size; a short one takes the minimum.
      const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
      expect([grown?.width, grown?.height], label).toEqual(want);
      __resetZoomForTests();
      vi.clearAllMocks();
      tauri.moved = [];
    }
  });

  it("stops re-growing a window the platform keeps refusing, until its size or target changes", async () => {
    // An X11 tiling WM refuses each grow and move and answers with a
    // configure, which reaches the app as a resize or move event.
    await startOnScreen();
    const echo = async () => {
      for (const cb of tauri.moved) cb();
    };
    tauri.setSize.mockImplementation(echo);
    tauri.setPosition.mockImplementation(echo);
    const writes = () =>
      [tauri.setMinSize, tauri.setSize, tauri.setPosition]
        .map((call) => call.mock.calls.length)
        .reduce((a, b) => a + b);
    const settle = async (passes: number) => {
      for (let i = 0; i < passes; i++) {
        await vi.advanceTimersByTimeAsync(200);
        await flush();
      }
    };
    setZoomLevel(1.25, "action");
    await flush();
    const zoomWrites = writes();
    await settle(12);
    // One re-armed grow and its move, then nothing.
    expect(writes() - zoomWrites).toBeLessThanOrEqual(2);
    expect(tauri.setSize).toHaveBeenCalledTimes(2);
    // The user resizes it, still below the minimum: one more try.
    tauri.innerSize.mockResolvedValue(tauri.size(705, 610));
    tauri.outerSize.mockResolvedValue(tauri.size(721, 649));
    const resized = writes();
    await pass();
    await settle(12);
    expect(writes() - resized).toBeLessThanOrEqual(2);
    expect(tauri.setSize).toHaveBeenCalledTimes(3);
    // A new target sends its own grow, then re-arms once more.
    setZoomLevel(1.5, "action");
    await flush();
    await settle(12);
    expect(tauri.setSize).toHaveBeenCalledTimes(5);
  });

  it("re-grows a window the drag's release snaps back below its minimum", async () => {
    // A pass during a still hold grows the window, Windows applies it, and
    // the release re-applies the drag's 1294×935 rect.
    let size = tauri.size(1294, 935);
    tauri.innerSize.mockImplementation(async () => size);
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.setSize.mockImplementation(
      async (s: { width: number; height: number }) => {
        size = tauri.size(s.width, s.height);
      },
    );
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1080));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 0 });
    await start();
    setZoomLevel(1.75, "action");
    await flush();
    tauri.setSize.mockImplementationOnce(async () => undefined);
    setZoomLevel(2, "action");
    await flush();
    expect(size).toEqual(tauri.size(1294, 935));
    await pass();
    expect(size).toEqual(tauri.size(1294, 1000));
    const grows = tauri.setSize.mock.calls.length;
    size = tauri.size(1294, 935);
    await pass();
    const regrown = tauri.setSize.mock.calls.slice(grows);
    expect(regrown.map(([s]) => [s.width, s.height])).toEqual([[1294, 1000]]);
  });

  it("holds a lower that could grow a window a drag left below it on an unknown display", async () => {
    await startOnScreen();
    // The grow to 200% is swallowed: the window stays 700×600.
    setZoomLevel(2, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([1136, 1000]);
    // The newest pass fails, leaving the display unknown.
    tauri.outerSize.mockRejectedValueOnce(new Error("ipc"));
    await pass();
    const native = growNatively(tauri.size(700, 600));
    setZoomLevel(1.5, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([1136, 1000]);
    expect(native.size).toEqual(tauri.size(700, 600));
    // A known pass sends it: the window grows and moves back on screen.
    const moves = tauri.setPosition.mock.calls.length;
    await pass();
    expect(minSizes().at(-1)).toEqual([852, 750]);
    expect(native.size).toEqual(tauri.size(852, 750));
    expect(tauri.setPosition).toHaveBeenCalledTimes(moves + 1);
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 251]);
  });

  it("sends a lower the window meets at once on an unknown display", async () => {
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    setZoomLevel(1.5, "action");
    await flush();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([
      [852, 750],
      [710, 625],
    ]);
  });

  /** A 125% grow whose move holds its position read while a newer pass lands
   *  `area`; the grown window then reads 710×625. */
  async function passDuringPositionRead(area: ReturnType<typeof monitor>) {
    await startOnScreen();
    const position = deferred<{ x: number; y: number }>();
    tauri.outerPosition.mockReturnValueOnce(position.promise);
    setZoomLevel(1.25, "action");
    await flush();
    tauri.currentMonitor.mockResolvedValue(area);
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    await pass();
    position.resolve({ x: 100, y: 400 });
    await flush();
  }

  it("places against the new bounds when a pass changes them during the position read", async () => {
    await passDuringPositionRead(monitor(1920, 900));
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([100, 900 - 664]);
  });

  it("keeps placing when an overlapping pass lands the same bounds", async () => {
    await passDuringPositionRead(monitor(1920, 1040));
    expect(tauri.outerPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([100, 376]);
  });

  /** A 1920×1040 monitor whose work area starts at (`x`, `y`) and is `width`
   *  wide. */
  const areaAt = (x: number, width: number, y = 0) => ({
    ...monitor(1920, 1040),
    workArea: { position: { x, y }, size: tauri.size(width, 1040) },
  });

  it("places against the new bounds when a pass changes only their y during the position read", async () => {
    await passDuringPositionRead(areaAt(0, 1920, -300));
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([100, 740 - 664]);
  });

  /** A 700×600 window at (100, 100) that the user enlarges to 1000×800 during
   *  the trailing scale read of the size read after the 125% minimum, firing
   *  `events()` there; the scale stays put, so that read answers 700×600. */
  async function enlargeDuringRead(events: () => Array<() => void>) {
    let size = tauri.size(700, 600);
    let armed = false;
    let enlarge = false;
    tauri.innerSize.mockImplementation(async () => {
      if (armed) {
        armed = false;
        enlarge = true;
      }
      return size;
    });
    tauri.scaleFactor.mockImplementation(async () => {
      if (enlarge) {
        enlarge = false;
        size = tauri.size(1000, 800);
        for (const cb of events()) cb();
      }
      return 1;
    });
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 100 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    tauri.setMinSize.mockImplementation(async () => {
      armed = true;
    });
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([[710, 625]]);
  }

  it("never grows from a size read a resize event made stale before setSize", async () => {
    await enlargeDuringRead(() => tauri.resized);
    expect(tauri.setSize).not.toHaveBeenCalled();
    // The resize's own pass finds the window meeting the minimum, on screen.
    await pass([]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  it("counts only resize events against a size read", async () => {
    // NEGATIVE CONTROL: a move event in the same window leaves the read
    // standing, so the grow goes out from it.
    await enlargeDuringRead(() => tauri.windowMoved);
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown?.width, grown?.height]).toEqual([710, 625]);
  });

  it("leaves a size read standing when the window gains focus during it", async () => {
    await enlargeDuringRead(() => focusEvents(true));
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown?.width, grown?.height]).toEqual([710, 625]);
  });

  it("owes no move after a resize skips a re-armed grow", async () => {
    // A parked 800×700 window overflowing the right edge meets the raise;
    // a snap-back leaves it 700×600 with nothing owed, and the user enlarges
    // it to 900×800 during the re-arm's size read.
    let size = tauri.size(800, 700);
    tauri.innerSize.mockImplementation(async () => size);
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.outerPosition.mockResolvedValue({ x: 1400, y: 100 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    size = tauri.size(700, 600);
    // The pass reads the inner size twice for the frame, then once to decide.
    let reads = -1;
    let enlarge = false;
    tauri.currentMonitor.mockImplementation(async () => {
      reads = 0;
      return monitor(1920, 1040);
    });
    tauri.innerSize.mockImplementation(async () => {
      if (reads >= 0 && ++reads === 3) enlarge = true;
      return size;
    });
    tauri.scaleFactor.mockImplementation(async () => {
      if (enlarge) {
        enlarge = false;
        reads = -1;
        size = tauri.size(900, 800);
        for (const cb of tauri.resized) cb();
      }
      return 1;
    });
    await pass();
    expect(tauri.setSize).not.toHaveBeenCalled();
    await pass([]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  it("holds a change on an unknown display when a resize lands during its size read", async () => {
    // Both reads answer 1000×800; the window is resized to 700×600 during
    // the second read's trailing scale read.
    let size = tauri.size(1000, 800);
    let reads = -1;
    let shrink = false;
    tauri.innerSize.mockImplementation(async () => {
      if (reads >= 0 && ++reads === 2) shrink = true;
      return size;
    });
    tauri.scaleFactor.mockImplementation(async () => {
      if (shrink) {
        shrink = false;
        reads = -1;
        size = tauri.size(700, 600);
        for (const cb of tauri.resized) cb();
      }
      return 1;
    });
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    reads = 0;
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([]);
    // The resize's pass, still on an unknown display, reads it too small.
    await pass([]);
    expect(minSizes()).toEqual([]);
  });

  it("defers the move back on screen when the window is maximized before it", async () => {
    // A 710×625 window met the raise with its bottom past the area; a
    // snap-back to 700×600 re-arms the grow, and the window is maximized
    // during it.
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 400 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.setSize.mockImplementationOnce(async () => {
      tauri.isMaximized.mockResolvedValue(true);
      tauri.outerPosition.mockResolvedValue({ x: -8, y: -8 });
    });
    await pass();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    expect(tauri.setPosition).not.toHaveBeenCalled();
    // Restored at its grown size, the owed move goes out.
    tauri.isMaximized.mockResolvedValue(false);
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    tauri.outerPosition.mockResolvedValue({ x: 100, y: 400 });
    await pass();
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([100, 376]);
  });

  it("keeps the last frame when a shrink tears the frame read", async () => {
    // The 16×39 frame on a 1000×740 area caps the saved 200% at 125%.
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 2 }));
    tauri.currentMonitor.mockResolvedValue(monitor(1000, 740));
    tauri.innerSize.mockResolvedValue(tauri.size(900, 700));
    tauri.outerSize.mockResolvedValue(tauri.size(916, 739));
    await start();
    expect([level(), getZoomState().max]).toEqual([1.25, 1.25]);
    // The window shrinks to 700×600 during the outer read: paired with the
    // later inner read, the outer size gives a fictitious 216×139 frame.
    tauri.outerSize.mockImplementationOnce(async () => {
      tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
      tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
      return tauri.size(916, 739);
    });
    await pass();
    expect([level(), getZoomState().max]).toEqual([1.25, 1.25]);
  });

  it("keeps the last frame when a resize tears the frame read", async () => {
    // The 16×39 frame on a 1000×740 area caps the saved 200% at 125%.
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 2 }));
    tauri.currentMonitor.mockResolvedValue(monitor(1000, 740));
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    await start();
    expect([level(), getZoomState().max]).toEqual([1.25, 1.25]);
    // The window resizes to 900×700 between the outer and inner reads: read
    // together they give a −184×−61 frame.
    tauri.outerSize.mockImplementationOnce(async () => {
      tauri.innerSize.mockResolvedValue(tauri.size(900, 700));
      tauri.outerSize.mockResolvedValue(tauri.size(916, 739));
      return tauri.size(716, 639);
    });
    await pass();
    expect([level(), getZoomState().max]).toEqual([1.25, 1.25]);
  });

  it("decides nothing from a size read whose first scale read is stale", async () => {
    // The display drops from 200% to 100% between the first scale read and
    // the size read; Windows keeps the logical 800×700, now 800×700 px.
    let scale = 2;
    let size = tauri.size(1600, 1400);
    let flip = false;
    tauri.scaleFactor.mockImplementation(async () => {
      const read = scale;
      if (flip) {
        flip = false;
        scale = 1;
        size = tauri.size(800, 700);
      }
      return read;
    });
    tauri.innerSize.mockImplementation(async () => size);
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    tauri.setMinSize.mockImplementation(async () => {
      flip = true;
    });
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([[710, 625]]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    // NEGATIVE CONTROL: read whole at 100%, the window meets the minimum.
    await pass(tauri.scaled);
    expect(tauri.setSize).not.toHaveBeenCalled();
  });

  it("places against the new bounds when a pass changes only their width during the position read", async () => {
    await passDuringPositionRead(areaAt(0, 800));
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([800 - 726, 376]);
  });

  it("places against the new bounds when a pass changes only their x during the position read", async () => {
    await passDuringPositionRead(areaAt(200, 1920));
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([200, 376]);
  });

  it("defers the move back on screen when the scale changes during the position read", async () => {
    // The 1920×1080 area keeps its physical bounds at 125%, where the grown
    // 710×625 window is 888×781 px with a 20×49 px frame.
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.outerSize.mockResolvedValue(tauri.size(716, 639));
    tauri.outerPosition.mockResolvedValue({ x: 1200, y: 400 });
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1080));
    await start();
    const position = deferred<{ x: number; y: number }>();
    tauri.outerPosition.mockReturnValueOnce(position.promise);
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    tauri.scaleFactor.mockResolvedValue(1.25);
    tauri.innerSize.mockResolvedValue(tauri.size(888, 781));
    tauri.outerSize.mockResolvedValue(tauri.size(908, 830));
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1080, 1.25));
    await pass(tauri.scaled);
    position.resolve({ x: 1200, y: 400 });
    await flush();
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([1920 - 908, 1080 - 830]);
  });

  it("decides nothing from a size read torn across a scale change", async () => {
    // A DPI change to 200% lands just after the size read: the size is the
    // old scale's, and the window is 3200×1400 px now.
    let scale = 1;
    let size = tauri.size(1600, 700);
    let flip = false;
    tauri.scaleFactor.mockImplementation(async () => scale);
    tauri.innerSize.mockImplementation(async () => {
      const read = size;
      if (flip) {
        flip = false;
        scale = 2;
        size = tauri.size(3200, 1400);
      }
      return read;
    });
    tauri.outerSize.mockImplementation(async () =>
      tauri.size(size.width + 16, size.height + 39),
    );
    // The read after setMinSize is the torn one.
    tauri.setMinSize.mockImplementation(async () => {
      flip = true;
    });
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([[710, 625]]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    // NEGATIVE CONTROL: read whole at 200%, the window meets the minimum.
    await pass(tauri.scaled);
    expect(tauri.setSize).not.toHaveBeenCalled();
  });

  it("keeps the last frame when the frame read is torn across a scale change", async () => {
    // The 16×39 frame on a 1920×1000 area allows 175%.
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1000));
    await start();
    expect(getZoomState().max).toBe(1.75);
    // A DPI change to 200% lands during the outer size read: the outer size is
    // the old scale's, the inner size and the second scale read the new one's.
    let flip = true;
    tauri.outerSize.mockImplementation(async () => {
      if (!flip) return tauri.size(3232, 2078);
      flip = false;
      tauri.scaleFactor.mockResolvedValue(2);
      tauri.innerSize.mockResolvedValue(tauri.size(3200, 2000));
      return tauri.size(1616, 1039);
    });
    await pass(tauri.scaled);
    expect(getZoomState().max).toBe(1.75);
  });

  it("leaves a flush window in place at a fractional scale", async () => {
    // Rebuilt from logical px, 1784 + 14 px at 1.75 lands a hair over 1798.
    tauri.scaleFactor.mockResolvedValue(1.75);
    tauri.innerSize.mockResolvedValue(tauri.size(1784, 1400));
    tauri.outerSize.mockResolvedValue(tauri.size(1798, 1414));
    tauri.outerPosition.mockResolvedValue({ x: 3840 - 1798, y: 0 });
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160, 1.75));
    await start();
    setZoomLevel(1.75, "action");
    await flush();
    const [grown] = tauri.setSize.mock.calls.at(-1) ?? [];
    expect([grown?.width, grown?.height]).toEqual([1784 / 1.75, 875]);
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  it("moves a natively grown window on screen when a lower lands during setMinSize", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    const slow = deferred<void>();
    native.gate = slow.promise;
    setZoomLevel(1.25, "action");
    await flush();
    setZoomLevel(1.1, "action");
    await flush();
    slow.resolve();
    native.gate = Promise.resolve();
    await flush();
    expect(minSizes()).toEqual([
      [710, 625],
      [640, 600],
    ]);
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("folds requests made during a run into one more run, against the latest target", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    await start();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    const runs = tauri.isMinimized.mock.calls.length;
    setZoomLevel(1.5, "action");
    setZoomLevel(1.75, "action");
    await flush();
    // Nothing overtakes the call in flight.
    expect(minSizes()).toEqual([[710, 625]]);
    slow.resolve();
    await flush();
    expect(tauri.isMinimized).toHaveBeenCalledTimes(runs + 1);
    expect(minSizes()).toEqual([
      [710, 625],
      [994, 875],
    ]);
    expect(tauri.setSize).toHaveBeenCalledTimes(1);
    const [grown] = tauri.setSize.mock.calls[0];
    expect([grown.width, grown.height]).toEqual([994, 875]);
  });

  it("never lets an obsolete setMinSize completion stand for the accepted minimum", async () => {
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    const slow = deferred<void>();
    tauri.setMinSize.mockReturnValueOnce(slow.promise);
    setZoomLevel(1.25, "action");
    await flush();
    resetZoom("action");
    await flush();
    expect(minSizes()).toEqual([[710, 625]]);
    slow.resolve();
    await flush();
    expect(minSizes()).toEqual([
      [710, 625],
      [640, 600],
    ]);
    // The window holds 640×600, so 710×625 is a raise again: held on an
    // unknown display for a window below it.
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toHaveLength(2);
  });

  it("moves a natively grown window on screen after a failed size read", async () => {
    await startOnScreen();
    growNatively(tauri.size(700, 600));
    tauri.innerSize.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("moves a natively grown window on screen when a request lands during setMinSize", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    const slow = deferred<void>();
    native.gate = slow.promise;
    setZoomLevel(1.25, "action");
    await flush();
    await pass();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    slow.resolve();
    await flush();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).toHaveBeenCalledTimes(1);
    const [moved] = tauri.setPosition.mock.calls[0];
    expect([moved.x, moved.y]).toEqual([100, 376]);
  });

  it("moves a natively grown window on screen after its setMinSize call failed", async () => {
    await startOnScreen();
    const native = growNatively(tauri.size(700, 600));
    const failed = Promise.reject(new Error("ipc"));
    failed.catch(() => undefined);
    native.gate = failed;
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    native.gate = Promise.resolve();
    // The window already meets the minimum, yet the move is still owed.
    await pass();
    expect(minSizes()).toEqual([
      [710, 625],
      [710, 625],
    ]);
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect([moved?.x, moved?.y]).toEqual([100, 376]);
  });

  it("finishes a move retry that a newer request lands during", async () => {
    await startOnScreen();
    tauri.setPosition.mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    const position = deferred<{ x: number; y: number }>();
    tauri.outerPosition.mockReturnValueOnce(position.promise);
    await pass();
    await pass();
    position.resolve({ x: 100, y: 420 });
    await flush();
    expect(tauri.setPosition).toHaveBeenCalledTimes(2);
    const [moved] = tauri.setPosition.mock.calls[1];
    expect([moved.x, moved.y]).toEqual([100, 376]);
  });

  it("drops a failed move after its one retry, so a later park stays put", async () => {
    await startOnScreen();
    tauri.outerPosition
      .mockRejectedValueOnce(new Error("ipc"))
      .mockRejectedValueOnce(new Error("ipc"));
    setZoomLevel(1.25, "action");
    await flush();
    tauri.innerSize.mockResolvedValue(tauri.size(710, 625));
    tauri.outerSize.mockResolvedValue(tauri.size(726, 664));
    await pass();
    // The retry ran (and failed too).
    expect(tauri.outerPosition).toHaveBeenCalledTimes(2);
    // Parked past the right edge, its centre still inside the area.
    tauri.outerPosition.mockResolvedValue({ x: 1400, y: 300 });
    await pass();
    expect(tauri.outerPosition).toHaveBeenCalledTimes(2);
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  /** mulberry32: a seeded PRNG, so a failing sequence replays from its seed. */
  function seeded(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("settles seeded random sequences to the minimum, on screen, never shrinking", async () => {
    const SEED = 669;
    const SEQUENCES = 500;
    const random = seeded(SEED);
    const int = (lo: number, hi: number) =>
      lo + Math.floor(random() * (hi - lo + 1));
    const pick = <T>(items: readonly T[]) => items[int(0, items.length - 1)];
    const ticks = async (n: number) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };
    const FRAME = { width: 16, height: 39 };
    // Two side-by-side displays per layout, sharing one scale.
    const LAYOUTS = [
      {
        scale: 1,
        areas: [
          { x: 0, y: 0, width: 1920, height: 1040 },
          { x: 1920, y: 0, width: 1366, height: 728 },
        ],
      },
      {
        scale: 1,
        areas: [
          { x: 0, y: 0, width: 900, height: 700 },
          { x: -1920, y: 0, width: 1920, height: 1040 },
        ],
      },
      {
        scale: 1.5,
        areas: [
          { x: 0, y: 0, width: 2880, height: 1560 },
          { x: 2880, y: 0, width: 2160, height: 1350 },
        ],
      },
      {
        scale: 1.25,
        areas: [
          { x: -2400, y: 0, width: 2400, height: 1300 },
          { x: 0, y: 0, width: 1700, height: 1000 },
        ],
      },
      {
        scale: 1.75,
        areas: [
          { x: 0, y: 0, width: 3360, height: 1890 },
          { x: 3360, y: 0, width: 2688, height: 1512 },
        ],
      },
      {
        scale: 2.25,
        areas: [
          { x: 0, y: 0, width: 3840, height: 2160 },
          { x: -2880, y: 0, width: 2880, height: 1620 },
        ],
      },
    ];
    type Size = { width: number; height: number };
    const NORMAL = { min: false, max: false, full: false };
    const NOT_NORMAL = [
      { ...NORMAL, min: true },
      { ...NORMAL, max: true },
      { ...NORMAL, full: true },
    ];
    let checked = 0;
    let leftBelowChecked = 0;
    let refuseChecked = 0;

    for (let s = 0; s < SEQUENCES; s++) {
      __resetZoomForTests();
      vi.clearAllMocks();
      localStorage.clear();
      tauri.moved = [];
      tauri.scaled = [];
      const { scale, areas } = pick(LAYOUTS);
      // A quarter of the sequences never learn a work area.
      const unknownOnly = random() < 0.25;
      const failRate = random() < 0.5 ? 0 : 0.15;
      const fitWidth = Math.min(...areas.map((a) => a.width / scale)) - 16;
      const fitHeight = Math.min(...areas.map((a) => a.height / scale)) - 39;
      // An X11 tiling WM: every grow and move is refused with a configure.
      const refuseAll = random() < 0.15;
      // The window holds whole physical px; tao rounds a logical size to them.
      const px = (v: number) => Math.round(v * scale);
      const quant = (s: Size) =>
        tauri.size(px(s.width) / scale, px(s.height) / scale);
      const sim = {
        inner: quant(
          tauri.size(pick([640, 660, 700, 720]), pick([600, 612, 640])),
        ),
        pos: { x: 0, y: 0 },
        display: int(0, 1),
        flags: NORMAL,
        osMin: tauri.size(640, 600),
        nativeGrow: random() < 0.5,
        answer: (unknownOnly ? "null" : "known") as "known" | "null" | "reject",
        failRate,
        // A drag in Windows' modal size loop: it snaps every grow back.
        dragging: false,
        // A pass while the drag holds still: Windows applies its grow, and the
        // release re-applies the drag rect.
        dragLands: false,
        // A drag left the window below its minimum at some point.
        leftBelow: false,
        resizeEpoch: 0,
        readEpoch: 0,
        violations: [] as string[],
        grew: false,
        // The user moved or resized the window (or it changed display), and no
        // grow, with its move back, followed.
        disturbed: false,
        moveFailed: false,
        // setSize and setPosition calls a refuse-all platform answered.
        refusedWrites: 0,
      };
      const area = () => areas[sim.display];
      // The display the newest landed pass left unknown, read from the
      // controller at each write: an answer landing mid-run must stop it.
      const areaUnknown = () =>
        unknownOnly || __zoomWorkAreaForTests() === null;
      const outer = () => ({
        width: px(sim.inner.width) + px(FRAME.width),
        height: px(sim.inner.height) + px(FRAME.height),
      });
      // Below the floor the OS holds the window at: the minimum in whole px.
      const belowOsMin = () =>
        px(sim.inner.width) < px(sim.osMin.width) ||
        px(sim.inner.height) < px(sim.osMin.height);
      // A refused write still yields a configure: a move or resize event.
      const echo = () => queueMicrotask(() => fire());
      const placeInside = () => {
        sim.pos = {
          x: area().x + int(0, Math.floor(area().width - outer().width)),
          y: area().y + int(0, Math.floor(area().height - outer().height)),
        };
      };
      placeInside();
      const normal = () => !sim.flags.min && !sim.flags.max && !sim.flags.full;
      const fails = () => random() < sim.failRate;
      const failLater = () =>
        ticks(int(0, 3)).then(() => {
          throw new Error("ipc");
        });
      const write = (what: string) => {
        if (!normal()) sim.violations.push(`${what} while not normal`);
      };
      const resize = (size: Size) => {
        const to = quant(size);
        const eps = 1e-6;
        if (
          (to.width < sim.inner.width - eps ||
            to.height < sim.inner.height - eps) &&
          sim.readEpoch === sim.resizeEpoch
        )
          sim.violations.push("shrank from a current read");
        if (
          to.width > sim.inner.width + eps ||
          to.height > sim.inner.height + eps
        ) {
          sim.grew = true;
          sim.disturbed = false;
          sim.moveFailed = false;
          if (areaUnknown()) sim.violations.push("grew on an unknown display");
        }
        sim.inner = tauri.size(to.width, to.height);
      };
      // Reads made together answer together, from one snapshot taken when
      // they resolve: a window read is answered when processed, not when sent.
      let batch: Promise<{
        inner: Size;
        pos: { x: number; y: number };
      }> | null = null;
      const snapshot = () => {
        if (!batch) {
          batch = ticks(int(0, 3)).then(() => {
            sim.readEpoch = sim.resizeEpoch;
            return { inner: { ...sim.inner }, pos: { ...sim.pos } };
          });
          queueMicrotask(() => {
            batch = null;
          });
        }
        return batch;
      };
      const flag = (key: "min" | "max" | "full") =>
        ticks(int(0, 3)).then(() => sim.flags[key]);
      tauri.isMinimized.mockImplementation(() => flag("min"));
      tauri.isMaximized.mockImplementation(() => flag("max"));
      tauri.isFullscreen.mockImplementation(() => flag("full"));
      tauri.scaleFactor.mockImplementation(() => snapshot().then(() => scale));
      tauri.innerSize.mockImplementation(() =>
        fails()
          ? failLater()
          : snapshot().then(({ inner }) =>
              tauri.size(px(inner.width), px(inner.height)),
            ),
      );
      // Only a monitor pass reads the outer size: a rejected answer fails the
      // whole pass there, as a null one lands without failing it.
      tauri.outerSize.mockImplementation(() =>
        sim.answer === "reject"
          ? failLater()
          : snapshot().then(({ inner }) =>
              tauri.size(
                px(inner.width) + px(FRAME.width),
                px(inner.height) + px(FRAME.height),
              ),
            ),
      );
      tauri.outerPosition.mockImplementation(() => {
        if (!fails()) return snapshot().then(({ pos }) => pos);
        sim.moveFailed = true;
        return failLater();
      });
      tauri.setMinSize.mockImplementation((min: Size) => {
        write("setMinSize");
        if (
          areaUnknown() &&
          (min.width > sim.osMin.width || min.height > sim.osMin.height) &&
          (px(min.width) > px(sim.inner.width) ||
            px(min.height) > px(sim.inner.height))
        )
          sim.violations.push("raised past the window on an unknown display");
        const failed = fails();
        // A failed call may still have reached the window.
        if (!failed || random() < 0.5) {
          sim.osMin = tauri.size(min.width, min.height);
          if (
            sim.nativeGrow &&
            !(sim.dragging && !sim.dragLands) &&
            !refuseAll
          ) {
            resize({
              width: Math.max(sim.inner.width, min.width),
              height: Math.max(sim.inner.height, min.height),
            });
          }
        }
        return failed ? failLater() : ticks(int(0, 3));
      });
      tauri.setSize.mockImplementation((size: Size) => {
        write("setSize");
        // Resolves as if it landed, but the drag holds the size.
        if (sim.dragging && !sim.dragLands) return ticks(int(0, 3));
        if (refuseAll) {
          sim.refusedWrites++;
          echo();
          return ticks(int(0, 3));
        }
        const failed = fails();
        if (!failed || random() < 0.5) resize(size);
        return failed ? failLater() : ticks(int(0, 3));
      });
      tauri.setPosition.mockImplementation((p: { x: number; y: number }) => {
        write("setPosition");
        if (areaUnknown()) sim.violations.push("moved on an unknown display");
        if (!Number.isInteger(p.x) || !Number.isInteger(p.y))
          sim.violations.push("fractional position");
        if (refuseAll) {
          sim.refusedWrites++;
          echo();
          return ticks(int(0, 3));
        }
        if (fails()) {
          sim.moveFailed = true;
          return failLater();
        }
        sim.pos = { x: p.x, y: p.y };
        return ticks(int(0, 3));
      });
      tauri.currentMonitor.mockImplementation(() => {
        const answer = sim.answer;
        if (answer === "reject") return failLater();
        return ticks(int(0, 3)).then(() => {
          if (answer === "null") return null;
          const a = area();
          return {
            name: null,
            size: tauri.size(a.width, a.height),
            position: { x: a.x, y: a.y },
            workArea: {
              position: { x: a.x, y: a.y },
              size: tauri.size(a.width, a.height),
            },
            scaleFactor: scale,
          };
        });
      });
      const fire = () => {
        for (const cb of tauri.moved) cb();
      };
      const drain = () => ticks(300);
      /** Lets the debounced pass run and every reconcile settle. */
      const land = async () => {
        await vi.advanceTimersByTimeAsync(250);
        await drain();
      };

      initZoom();
      await drain();
      const steps = int(4, 24);
      for (let i = 0; i < steps; i++) {
        const r = random();
        if (r < 0.3) {
          if (random() < 0.5) setZoomLevel(pick(ZOOM_STEPS), "action");
          else stepZoom(random() < 0.6 ? 1 : -1, "wheel");
        } else if (r < 0.42) {
          // A known answer races whatever is in flight.
          if (!unknownOnly) sim.answer = "known";
          fire();
          await vi.advanceTimersByTimeAsync(int(150, 250));
        } else if (r < 0.5) {
          // A null or failed answer, landing while a run may be in flight:
          // the last millisecond fires the pass without draining, so a zoom
          // made just before or after races it.
          sim.answer = pick(["null", "reject"] as const);
          fire();
          await vi.advanceTimersByTimeAsync(199);
          const zoomAt = random();
          if (zoomAt < 0.5) setZoomLevel(pick(ZOOM_STEPS), "action");
          vi.advanceTimersByTime(1);
          if (zoomAt >= 0.75) setZoomLevel(pick(ZOOM_STEPS), "action");
        } else if (r < 0.6) {
          const next = random() < 0.6 ? NORMAL : pick(NOT_NORMAL);
          // Leaving normal waits for the run in flight, so any later write
          // while not normal is the controller's own.
          if (next !== NORMAL) await drain();
          sim.flags = next;
          fire();
        } else if (r < 0.66) {
          sim.nativeGrow = !sim.nativeGrow;
        } else if (r < 0.74 && normal()) {
          // A drag within the display, possibly partly off it.
          sim.pos = {
            x: area().x + int(-400, area().width - 200),
            y: area().y + int(-100, area().height - 200),
          };
          sim.disturbed = true;
          fire();
        } else if (r < 0.8 && normal()) {
          sim.disturbed = true;
          sim.resizeEpoch++;
          if (random() < 0.5) {
            // Enlarging races the run in flight.
            sim.inner = tauri.size(
              int(sim.inner.width, Math.max(sim.inner.width, fitWidth)),
              int(sim.inner.height, Math.max(sim.inner.height, fitHeight)),
            );
          } else {
            // Shrinking waits for it, and stops at the window's minimum.
            await drain();
            sim.resizeEpoch++;
            sim.inner = tauri.size(
              int(sim.osMin.width, Math.max(sim.osMin.width, sim.inner.width)),
              int(
                sim.osMin.height,
                Math.max(sim.osMin.height, sim.inner.height),
              ),
            );
          }
          sim.inner = quant(sim.inner);
          fire();
        } else if (r < 0.86 && normal()) {
          // A size drag held while the zoom changes: the window takes the
          // drag's size and keeps it whatever the reconcile sends, so the
          // release can leave it below its minimum.
          await drain();
          sim.disturbed = true;
          sim.resizeEpoch++;
          sim.dragging = true;
          sim.inner = tauri.size(
            int(sim.osMin.width, Math.max(sim.osMin.width, fitWidth)),
            int(sim.osMin.height, Math.max(sim.osMin.height, fitHeight)),
          );
          sim.inner = quant(sim.inner);
          fire();
          if (random() < 0.5) setZoomLevel(pick(ZOOM_STEPS), "action");
          else stepZoom(1, "action");
          await ticks(int(0, 60));
          const dragRect = sim.inner;
          if (random() < 0.5) {
            sim.dragLands = true;
            fire();
            await land();
            sim.dragLands = false;
            sim.resizeEpoch++;
            sim.inner = dragRect;
            sim.disturbed = true;
          }
          sim.dragging = false;
          if (belowOsMin()) sim.leftBelow = true;
          fire();
        } else if (r < 0.92 && normal() && !unknownOnly) {
          // A drag onto the other display, landed whole.
          await drain();
          sim.display = 1 - sim.display;
          placeInside();
          sim.disturbed = true;
          sim.answer = "known";
          fire();
          await land();
        } else {
          await vi.advanceTimersByTimeAsync(int(0, 300));
        }
        await ticks(int(0, 30));
      }

      // Settle without failures: a last pass (as the final state change would
      // trigger) lands, and the reconciles it asks for finish.
      sim.failRate = 0;
      const finalNormal = random() < 0.8;
      await drain();
      sim.flags = finalNormal ? NORMAL : pick(NOT_NORMAL);
      if (!unknownOnly) sim.answer = random() < 0.7 ? "known" : "null";
      fire();
      for (let round = 0; round < 2; round++) await land();

      const label = `seed ${SEED}, sequence ${s}`;
      expect(sim.violations, label).toEqual([]);
      if (unknownOnly) expect(sim.grew, label).toBe(false);
      if (finalNormal && sim.answer === "known" && refuseAll) {
        refuseChecked++;
        expect(sim.osMin, label).toEqual(minWindowSizeFor(level()));
        // Each refused write echoes a pass; past one re-armed grow and its
        // move, none writes again while nothing changes.
        const refused = sim.refusedWrites;
        for (let round = 0; round < 10; round++) await land();
        expect(
          sim.refusedWrites - refused,
          `${label}: refused writes repeat`,
        ).toBeLessThanOrEqual(2);
      } else if (finalNormal && sim.answer === "known") {
        checked++;
        if (sim.leftBelow) leftBelowChecked++;
        expect(sim.osMin, label).toEqual(minWindowSizeFor(level()));
        expect(belowOsMin(), `${label}: window below its minimum`).toBe(false);
        // A settled window takes no write from an idle pass.
        const writes = () =>
          [tauri.setMinSize, tauri.setSize, tauri.setPosition]
            .map((call) => call.mock.calls.length)
            .reduce((a, b) => a + b);
        const settled = writes();
        fire();
        await land();
        expect(writes() - settled, `${label}: idle pass wrote`).toBe(0);
        const { width, height } = outer();
        const a = area();
        const fits = width <= a.width && height <= a.height;
        if (!sim.disturbed && !sim.moveFailed && fits) {
          const centreX = sim.pos.x + width / 2;
          const centreY = sim.pos.y + height / 2;
          const centreInside =
            centreX >= a.x &&
            centreX < a.x + a.width &&
            centreY >= a.y &&
            centreY < a.y + a.height;
          const inside =
            sim.pos.x >= a.x &&
            sim.pos.y >= a.y &&
            sim.pos.x + width <= a.x + a.width &&
            sim.pos.y + height <= a.y + a.height;
          expect(!centreInside || inside, `${label}: left off-screen`).toBe(
            true,
          );
        }
      }
    }
    // The settled checks ran on a real share of the sequences, windows a drag
    // left below their minimum included.
    expect(checked).toBeGreaterThan(SEQUENCES / 5);
    expect(leftBelowChecked).toBeGreaterThan(0);
    expect(refuseChecked).toBeGreaterThan(0);
  });
});

describe("monitor clamp", () => {
  it("clamps the applied level without rewriting the saved one, and restores it", async () => {
    localStorage.setItem("gd-zoom", "1.5");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
    queryClient.setQueryData(settingsKeys.settings, settings({ zoom: 1.5 }));
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    // 900×700 minus the 16×39 frame fits 125% but not 150%.
    expect(getZoomState()).toEqual({ level: 1.25, max: 1.25, saved: 1.5 });
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(cachedZoom()).toBe(1.5);
    expect(localStorage.getItem("gd-zoom")).toBe("1.5");

    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(getZoomState()).toEqual({ level: 1.5, max: 2, saved: 1.5 });
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("counts a null or failed monitor read as the first answer, keeping the max", async () => {
    for (const read of [
      () => Promise.resolve(null),
      () => Promise.reject(new Error("no monitor")),
    ]) {
      tauri.currentMonitor.mockImplementation(read);
      localStorage.setItem("gd-zoom", "1.5");
      vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
      await start();
      expect(getZoomState()).toEqual({ level: 1.5, max: 2, saved: 1.5 });
      expect(minSizes().at(-1)).toEqual([852, 750]);
      __resetZoomForTests();
      vi.clearAllMocks();
    }
  });

  it("re-applies the min size at an unchanged level once a window leaves maximized", async () => {
    tauri.isMaximized.mockResolvedValue(true);
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(tauri.setMinSize).not.toHaveBeenCalled();
    tauri.isMaximized.mockResolvedValue(false);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(minSizes().at(-1)).toEqual([710, 625]);
  });

  it("sends an unchanged minimum once, a not-normal pass included", async () => {
    await start();
    // tauri.conf.json's 640×600 is 100%'s minimum: nothing to send.
    expect(minSizes()).toEqual([]);
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).toEqual([[710, 625]]);
    const reads = tauri.innerSize.mock.calls.length;
    await pass();
    // A pass with nothing owed reads the frame (the inner size around the
    // outer) and the size, and writes nothing.
    expect(tauri.innerSize).toHaveBeenCalledTimes(reads + 3);
    expect(tauri.setSize).not.toHaveBeenCalled();
    tauri.isMaximized.mockResolvedValue(true);
    await pass();
    tauri.isMaximized.mockResolvedValue(false);
    await pass();
    // The window keeps the minimum it accepted across maximize and restore.
    expect(minSizes()).toEqual([[710, 625]]);
  });

  it("never raises the minimum past the window or grows it when the monitor is unknown", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes()).not.toContainEqual([710, 625]);
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
    // Negative control: a known monitor grows the same window.
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    setZoomLevel(1.5, "action");
    await flush();
    expect(tauri.setSize).toHaveBeenCalled();
  });

  it("discards a monitor pass that a newer pass overtook", async () => {
    await start();
    const older = deferred<ReturnType<typeof monitor>>();
    const newer = deferred<ReturnType<typeof monitor>>();
    tauri.currentMonitor
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    newer.resolve(monitor(3840, 2160));
    await flush();
    older.resolve(monitor(900, 700));
    await flush();
    expect(getZoomState()).toEqual({ level: 1, max: 2, saved: 1 });
  });

  it("skips the whole pass while minimized", async () => {
    tauri.isMinimized.mockResolvedValue(true);
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    expect(tauri.currentMonitor).not.toHaveBeenCalled();
    expect(getZoomState().max).toBe(2);
    // Negative control: restored, the next resize reads the monitor.
    tauri.isMinimized.mockResolvedValue(false);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(getZoomState().max).toBe(1.25);
  });
});

describe("monitor pass pins", () => {
  it("publishes a saved-only change, and keeps the snapshot otherwise", async () => {
    localStorage.setItem("gd-zoom", "1.1");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.1 }));
    tauri.currentMonitor.mockResolvedValue(monitor(640, 560));
    await start();
    const clamped = getZoomState();
    expect(clamped).toEqual({ level: 1, max: 1, saved: 1.1 });
    await pass();
    expect(getZoomState()).toBe(clamped);
    resetZoom("action");
    expect(getZoomState()).toEqual({ level: 1, max: 1, saved: 1 });
    expect(saveSettingsPatch).toHaveBeenCalledWith({ zoom: 1 });
  });

  it("clamps a reconcile that lands after the monitor answer", async () => {
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    expect(getZoomState().max).toBe(1.25);
    load.resolve(settings({ zoom: 1.5 }));
    await flush();
    expect(level()).toBe(1.25);
  });

  it("re-reads the monitor on a scale change", async () => {
    await start();
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await pass(tauri.scaled);
    expect(getZoomState().max).toBe(1.25);
  });

  it("re-reads a work area that shrank without a window event on focus", async () => {
    localStorage.setItem("gd-zoom", "2");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 2 }));
    tauri.innerSize.mockResolvedValue(tauri.size(1400, 1100));
    tauri.outerSize.mockResolvedValue(tauri.size(1416, 1139));
    tauri.currentMonitor.mockResolvedValue(monitor(3440, 1400));
    await start();
    expect(getZoomState()).toEqual({ level: 2, max: 2, saved: 2 });
    expect(minSizes().at(-1)).toEqual([1136, 1000]);
    tauri.currentMonitor.mockResolvedValue(monitor(1366, 728));
    await pass(focusEvents(true));
    expect(getZoomState()).toEqual({ level: 1.25, max: 1.25, saved: 2 });
    expect(minSizes().at(-1)).toEqual([710, 625]);
    expect(__zoomWorkAreaForTests()).toEqual({
      x: 0,
      y: 0,
      width: 1366,
      height: 728,
    });
  });

  it("reads nothing when the window loses focus", async () => {
    await start();
    const reads = tauri.currentMonitor.mock.calls.length;
    await pass(focusEvents(false));
    expect(tauri.currentMonitor).toHaveBeenCalledTimes(reads);
    // NEGATIVE CONTROL: gaining focus reads the monitor once.
    await pass(focusEvents(true));
    expect(tauri.currentMonitor).toHaveBeenCalledTimes(reads + 1);
  });

  it("writes no geometry on focus while the display is unchanged", async () => {
    tauri.currentMonitor.mockResolvedValue(monitor(1920, 1040));
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    const reads = tauri.currentMonitor.mock.calls.length;
    tauri.setMinSize.mockClear();
    tauri.setSize.mockClear();
    tauri.setPosition.mockClear();
    await pass(focusEvents(true));
    expect(tauri.currentMonitor).toHaveBeenCalledTimes(reads + 1);
    expect(tauri.setMinSize).not.toHaveBeenCalled();
    expect(tauri.setSize).not.toHaveBeenCalled();
    expect(tauri.setPosition).not.toHaveBeenCalled();
  });

  it("never lands the max of a maximized pass a newer pass overtook", async () => {
    await start();
    const older = deferred<ReturnType<typeof monitor>>();
    tauri.currentMonitor.mockReturnValueOnce(older.promise);
    tauri.isMaximized.mockResolvedValueOnce(true);
    await pass();
    await pass();
    older.resolve(monitor(900, 700));
    await flush();
    expect(getZoomState().max).toBe(2);
  });

  it("never lands a pass overtaken during its frame read", async () => {
    await start();
    tauri.currentMonitor.mockResolvedValueOnce(monitor(900, 700));
    const outer = deferred<ReturnType<typeof tauri.size>>();
    tauri.outerSize.mockReturnValueOnce(outer.promise);
    await pass();
    await pass();
    outer.resolve(tauri.size(1616, 1039));
    await flush();
    expect(getZoomState().max).toBe(2);
  });
});

describe("toast and sources", () => {
  const lastToast = () => vi.mocked(toast).mock.calls.at(-1);

  it("never toasts a Settings change, but applies and persists it", async () => {
    await start();
    setZoomLevel(1.25, "settings");
    expect(toast).not.toHaveBeenCalled();
    expect(level()).toBe(1.25);
    expect(saveSettingsPatch).toHaveBeenCalledWith({ zoom: 1.25 });
    expect(tauri.setZoom).toHaveBeenLastCalledWith(1.25);
  });

  it("toasts user changes with a stable id and a Reset action", async () => {
    await start();
    stepZoom(1, "action");
    stepZoom(1, "wheel");
    const [text, opts] = lastToast() ?? [];
    expect(text).toBe("Zoom 125%");
    expect(opts).toMatchObject({ duration: 2000 });
    expect(opts?.id).toMatch(/^app-zoom/);
    expect(vi.mocked(toast).mock.calls[0][1]?.id).toBe(opts?.id);
    // sonner closes the toast after its action runs; that default is accepted.
    const action = opts?.action as
      | { onClick: (e: unknown) => void }
      | undefined;
    expect(action).toBeDefined();
    action?.onClick({});
    expect(level()).toBe(1);
  });

  it("passes an explicit undefined action at 100%", async () => {
    await start();
    stepZoom(1, "action");
    expect(lastToast()?.[1]?.action).toBeDefined();
    resetZoom("action");
    const opts = lastToast()?.[1] ?? {};
    expect(Object.hasOwn(opts, "action")).toBe(true);
    expect(opts.action).toBeUndefined();
  });

  it("names the limit past a boundary and persists nothing", async () => {
    await start();
    setZoomLevel(2, "action");
    vi.mocked(saveSettingsPatch).mockClear();
    stepZoom(1, "action");
    expect(lastToast()?.[0]).toBe("Zoom 200% · maximum");
    setZoomLevel(0.8, "action");
    vi.mocked(saveSettingsPatch).mockClear();
    stepZoom(-1, "wheel");
    expect(lastToast()?.[0]).toBe("Zoom 80% · minimum");
    await vi.advanceTimersByTimeAsync(400);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(level()).toBe(0.8);
  });

  it("opens a fresh toast once sonner reports the current one closed", async () => {
    await start();
    stepZoom(1, "action");
    const opts = lastToast()?.[1];
    const first = opts?.id;
    // Negative control: a close report for another id changes nothing.
    opts?.onAutoClose?.({ ...opts, id: "app-zoom-old" } as never);
    stepZoom(1, "action");
    expect(lastToast()?.[1]?.id).toBe(first);
    for (const report of ["onAutoClose", "onDismiss"] as const) {
      const current = lastToast()?.[1];
      current?.[report]?.({ ...current, id: current.id } as never);
      stepZoom(1, "action");
      expect(lastToast()?.[1]?.id, report).not.toBe(current?.id);
    }
  });

  it("dismisses a visible zoom toast on a Settings change", async () => {
    await start();
    stepZoom(1, "action");
    const id = lastToast()?.[1]?.id;
    setZoomLevel(1.5, "settings");
    expect(toast.dismiss).toHaveBeenCalledWith(id);
    // With no zoom toast up, a Settings change dismisses nothing.
    vi.mocked(toast.dismiss).mockClear();
    setZoomLevel(1.25, "settings");
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("dismisses a visible zoom toast when the display clamps the level", async () => {
    await start();
    stepZoom(1, "action");
    stepZoom(1, "action");
    stepZoom(1, "action");
    const id = lastToast()?.[1]?.id;
    expect(lastToast()?.[0]).toBe("Zoom 150%");
    // Negative control: a pass that keeps the level dismisses nothing.
    await pass();
    expect(toast.dismiss).not.toHaveBeenCalled();
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await pass();
    expect(level()).toBe(1.25);
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });

  it("opens a fresh toast for the reset its own Reset action makes", async () => {
    await start();
    stepZoom(1, "action");
    const opts = lastToast()?.[1];
    const action = opts?.action as { onClick: (e: unknown) => void };
    action.onClick({});
    expect(level()).toBe(1);
    expect(lastToast()?.[0]).toBe("Zoom 100%");
    expect(lastToast()?.[1]?.id).not.toBe(opts?.id);
    // sonner is already deleting the clicked toast.
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("offers Reset for a clamped saved level shown at 100%", async () => {
    localStorage.setItem("gd-zoom", "1.1");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.1 }));
    tauri.currentMonitor.mockResolvedValue(monitor(640, 560));
    await start();
    stepZoom(1, "action");
    expect(lastToast()?.[0]).toBe("Zoom 100% · maximum for this display");
    expect(lastToast()?.[1]?.action).toBeDefined();
    // Negative control: with both levels at 100%, no Reset.
    resetZoom("action");
    expect(lastToast()?.[1]?.action).toBeUndefined();
  });

  it("dismisses a limit toast the reconcile makes stale", async () => {
    localStorage.setItem("gd-zoom", "2");
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    stepZoom(1, "action");
    const id = lastToast()?.[1]?.id;
    expect(lastToast()?.[0]).toBe("Zoom 200% · maximum");
    load.resolve(settings({ zoom: 1.25 }));
    await flush();
    expect(level()).toBe(1.25);
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });

  it("dismisses a limit toast when a pass lifts the display maximum", async () => {
    localStorage.setItem("gd-zoom", "1.25");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.25 }));
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    stepZoom(1, "action");
    const id = lastToast()?.[1]?.id;
    expect(lastToast()?.[0]).toBe("Zoom 125% · maximum for this display");
    // Negative control: a pass that moves neither level nor max keeps it.
    await pass();
    expect(toast.dismiss).not.toHaveBeenCalled();
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    await pass();
    expect(getZoomState()).toEqual({ level: 1.25, max: 2, saved: 1.25 });
    expect(toast.dismiss).toHaveBeenCalledWith(id);
  });

  it("keeps a plain level toast up when a pass moves only the maximum", async () => {
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    stepZoom(1, "action");
    expect(lastToast()?.[0]).toBe("Zoom 110%");
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    await pass();
    expect(getZoomState()).toEqual({ level: 1.1, max: 2, saved: 1.1 });
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("keeps a minimum toast up when a pass moves only the maximum", async () => {
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    setZoomLevel(0.8, "action");
    stepZoom(-1, "action");
    expect(lastToast()?.[0]).toBe("Zoom 80% · minimum");
    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    await pass();
    expect(getZoomState().max).toBe(2);
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("dismisses a visible zoom toast when the reconcile moves only the saved level", async () => {
    for (const disk of [1.1, 1]) {
      localStorage.setItem("gd-zoom", "1.1");
      const load = deferred<AppSettings>();
      vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
      // 640×560 bounds the applied level at 100%, below the saved 110%.
      tauri.currentMonitor.mockResolvedValue(monitor(640, 560));
      await start();
      stepZoom(1, "action");
      const id = lastToast()?.[1]?.id;
      // The toast offers Reset for the saved 110%.
      expect(lastToast()?.[1]?.action).toBeDefined();
      load.resolve(settings({ zoom: disk }));
      await flush();
      expect(getZoomState(), String(disk)).toEqual({
        level: 1,
        max: 1,
        saved: disk,
      });
      // Negative control: a reconcile that keeps the saved level keeps it up.
      if (disk === 1.1) expect(toast.dismiss).not.toHaveBeenCalled();
      else expect(toast.dismiss).toHaveBeenCalledWith(id);
      __resetZoomForTests();
      vi.clearAllMocks();
      localStorage.clear();
    }
  });

  it("updates one toast for rapid steps and opens a fresh one near its end", async () => {
    await start();
    stepZoom(1, "action");
    const first = lastToast()?.[1]?.id;
    await vi.advanceTimersByTimeAsync(1700);
    stepZoom(1, "action");
    expect(lastToast()?.[1]?.id).toBe(first);
    expect(toast.dismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1750);
    stepZoom(1, "action");
    expect(lastToast()?.[1]?.id).not.toBe(first);
    expect(toast.dismiss).toHaveBeenCalledWith(first);
  });

  it("shows every step against sonner's real toaster, near expiry included", async () => {
    sonner.real = await vi.importActual<typeof import("sonner")>("sonner");
    try {
      render(createElement(sonner.real.Toaster));
      await start();
      const settle = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      for (const offset of [2000, 2050, 2150]) {
        await act(async () => stepZoom(1, "action"));
        await settle(offset);
        const want = getZoomState().level === 1.1 ? "Zoom 125%" : "Zoom 150%";
        await act(async () => stepZoom(1, "action"));
        await settle(50);
        expect(screen.queryByText(want), `step at ${offset} ms`).not.toBeNull();
        await act(async () => resetZoom("action"));
        await settle(3000);
      }
      // Negative control: re-using the closing toast's id is what sonner drops.
      const probe = { id: "probe", duration: 2000 };
      await act(async () => sonner.real?.toast("Probe A", probe));
      await settle(2050);
      await act(async () => sonner.real?.toast("Probe B", probe));
      await settle(400);
      expect(screen.queryByText("Probe B")).toBeNull();
    } finally {
      sonner.real.toast.dismiss();
      sonner.real = null;
    }
  });

  it("names a display-bounded maximum", async () => {
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    setZoomLevel(2, "action");
    expect(level()).toBe(1.25);
    stepZoom(1, "action");
    expect(lastToast()?.[0]).toBe("Zoom 125% · maximum for this display");
  });
});

describe("persistence", () => {
  it("lands one trailing write for a wheel burst, carrying the final level", async () => {
    await start();
    wheel(-100);
    await vi.advanceTimersByTimeAsync(100);
    wheel(-100);
    await vi.advanceTimersByTimeAsync(100);
    wheel(-100);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(cachedZoom()).toBe(1.5);
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(saveSettingsPatch).mock.calls).toEqual([[{ zoom: 1.5 }]]);
    expect(localStorage.getItem("gd-zoom")).toBe("1.5");
  });

  it("flushes a pending wheel write before an action write", async () => {
    await start();
    wheel(-100);
    stepZoom(1, "action");
    expect(vi.mocked(saveSettingsPatch).mock.calls).toEqual([
      [{ zoom: 1.1 }],
      [{ zoom: 1.25 }],
    ]);
    await vi.advanceTimersByTimeAsync(400);
    expect(saveSettingsPatch).toHaveBeenCalledTimes(2);
  });

  it("rolls the cache and saved level back when a write rejects", async () => {
    await start();
    stepZoom(1, "action");
    await flush();
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("disk full"));
    stepZoom(1, "action");
    expect(cachedZoom()).toBe(1.25);
    await flush();
    expect(cachedZoom()).toBe(1.1);
    expect(localStorage.getItem("gd-zoom")).toBe("1.1");
    // The applied level rolls back with the toast, not on the next move.
    expect(level()).toBe(1.1);
    expect(tauri.setZoom).toHaveBeenLastCalledWith(1.1);
    expect(toastErrorWithNote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastErrorWithNote).mock.calls[0][1]).toBe(
      "Couldn't save the zoom level; it's back at 110%.",
    );
    const zooms = tauri.setZoom.mock.calls.length;
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(level()).toBe(1.1);
    expect(tauri.setZoom).toHaveBeenCalledTimes(zooms);
  });

  it("dismisses the zoom toast before the rejection's error toast", async () => {
    await start();
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("disk full"));
    stepZoom(1, "action");
    const id = vi.mocked(toast).mock.calls.at(-1)?.[1]?.id;
    expect(toast.dismiss).not.toHaveBeenCalled();
    await flush();
    expect(toast.dismiss).toHaveBeenCalledWith(id);
    expect(vi.mocked(toast.dismiss).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(toastErrorWithNote).mock.invocationCallOrder[0],
    );
  });

  it("rolls back to the display-bounded level when the saved one doesn't fit", async () => {
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    localStorage.setItem("gd-zoom", "1.5");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
    await start();
    expect(level()).toBe(1.25);
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("disk full"));
    stepZoom(-1, "action");
    expect(level()).toBe(1.1);
    await flush();
    expect(level()).toBe(1.25);
    expect(localStorage.getItem("gd-zoom")).toBe("1.5");
    expect(vi.mocked(toastErrorWithNote).mock.calls[0][1]).toBe(
      "Couldn't save the zoom level; it's back at 125%.",
    );
  });

  it("persists the saved level when a monitor hop clamps mid-wheel-burst", async () => {
    await start();
    wheel(-100);
    wheel(-100);
    wheel(-100);
    expect(level()).toBe(1.5);
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(level()).toBe(1.25);
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(saveSettingsPatch).mock.calls).toEqual([[{ zoom: 1.5 }]]);
    expect(localStorage.getItem("gd-zoom")).toBe("1.5");
  });

  it("doesn't let a late rejection stomp a newer change", async () => {
    await start();
    const write = deferred<AppSettings>();
    vi.mocked(saveSettingsPatch).mockReturnValueOnce(write.promise);
    stepZoom(1, "action");
    stepZoom(1, "action");
    await flush();
    write.reject(new Error("late"));
    await flush();
    expect(cachedZoom()).toBe(1.25);
    expect(localStorage.getItem("gd-zoom")).toBe("1.25");
    expect(toastErrorWithNote).not.toHaveBeenCalled();
  });

  it("rolls back to a landed write over a stale reconcile read", async () => {
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    stepZoom(1, "action");
    await flush();
    load.resolve(settings({ zoom: 1 }));
    await flush();
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("x"));
    stepZoom(1, "action");
    await flush();
    expect(level()).toBe(1.1);
  });

  it("records a landed older write's own value as the rollback target", async () => {
    await start();
    const w1 = deferred<AppSettings>();
    const w2 = deferred<AppSettings>();
    vi.mocked(saveSettingsPatch)
      .mockReturnValueOnce(w1.promise)
      .mockReturnValueOnce(w2.promise);
    stepZoom(1, "action");
    stepZoom(1, "action");
    w1.resolve(settings({ zoom: 1.1 }));
    await flush();
    w2.reject(new Error("x"));
    await flush();
    expect(level()).toBe(1.1);
  });

  it("rolls a rejection before the reconcile back to the mirror's level", async () => {
    localStorage.setItem("gd-zoom", "1.25");
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    vi.mocked(saveSettingsPatch).mockRejectedValueOnce(new Error("x"));
    await start();
    stepZoom(1, "action");
    await flush();
    expect(level()).toBe(1.25);
  });

  it("re-patches a cache another writer left stale once the write lands", async () => {
    await start();
    const write = deferred<AppSettings>();
    vi.mocked(saveSettingsPatch).mockReturnValueOnce(write.promise);
    stepZoom(1, "action");
    queryClient.setQueryData(settingsKeys.settings, settings({ zoom: 1 }));
    write.resolve(settings({ zoom: 1.1 }));
    await flush();
    expect(cachedZoom()).toBe(1.1);
  });

  it("never invalidates the settings query", () => {
    const banned =
      /invalidateQueries\s*\(\s*\{\s*queryKey:\s*settingsKeys\.settings/;
    expect(banned.test(zoomSource)).toBe(false);
    expect(zoomSource).not.toContain("invalidateQueries");
    // Negative control: the pattern does catch the banned shape.
    expect(
      banned.test("invalidateQueries({ queryKey: settingsKeys.settings })"),
    ).toBe(true);
  });
});

describe("startup", () => {
  it("applies the mirror before the store answers, then reconciles", async () => {
    localStorage.setItem("gd-zoom", "1.25");
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    expect(level()).toBe(1.25);
    expect(tauri.setZoom).toHaveBeenLastCalledWith(1.25);
    load.resolve(settings({ zoom: 1.75 }));
    await flush();
    expect(level()).toBe(1.75);
    expect(tauri.setZoom).toHaveBeenLastCalledWith(1.75);
    expect(localStorage.getItem("gd-zoom")).toBe("1.75");
  });

  it("lets a user change made before the reconcile win", async () => {
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    stepZoom(1, "action");
    load.resolve(settings({ zoom: 1.75 }));
    await flush();
    expect(level()).toBe(1.1);
  });

  it("persists a reset made before the reconcile at the mirror's level", async () => {
    localStorage.setItem("gd-zoom", "1");
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    resetZoom("action");
    expect(saveSettingsPatch).toHaveBeenCalledWith({ zoom: 1 });
    load.resolve(settings({ zoom: 1.5 }));
    await flush();
    expect(level()).toBe(1);
    expect(localStorage.getItem("gd-zoom")).toBe("1");
    // Negative control: after the reconcile, an unchanged reset writes nothing.
    vi.mocked(saveSettingsPatch).mockClear();
    resetZoom("action");
    expect(saveSettingsPatch).not.toHaveBeenCalled();
  });

  it("keeps a pre-reconcile user change in the mirror", async () => {
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    stepZoom(1, "action");
    load.resolve(settings({ zoom: 1.75 }));
    await flush();
    expect(localStorage.getItem("gd-zoom")).toBe("1.1");
  });

  describe("a pre-load choice against a 150% disk (mirror 100%)", () => {
    async function startPreLoad() {
      localStorage.setItem("gd-zoom", "1");
      queryClient.setQueryData(settingsKeys.settings, settings({ zoom: 1.5 }));
      const load = deferred<AppSettings>();
      vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
      const write = deferred<AppSettings>();
      vi.mocked(saveSettingsPatch).mockReturnValueOnce(write.promise);
      await start();
      stepZoom(1, "action");
      return { load, write };
    }

    it("C, L, W lands: the choice stands", async () => {
      const { load, write } = await startPreLoad();
      load.resolve(settings({ zoom: 1.5 }));
      await flush();
      write.resolve(settings({ zoom: 1.1 }));
      await flush();
      expect(level()).toBe(1.1);
      expect(cachedZoom()).toBe(1.1);
    });

    it("C, W lands, L: the choice stands", async () => {
      const { load, write } = await startPreLoad();
      write.resolve(settings({ zoom: 1.1 }));
      await flush();
      load.resolve(settings({ zoom: 1.5 }));
      await flush();
      expect(level()).toBe(1.1);
      expect(localStorage.getItem("gd-zoom")).toBe("1.1");
    });

    it("C, W rejects, L: the disk's level is adopted", async () => {
      const { load, write } = await startPreLoad();
      write.reject(new Error("disk full"));
      await flush();
      expect(level()).toBe(1);
      load.resolve(settings({ zoom: 1.5 }));
      expect(cachedZoom()).toBe(1);
      await flush();
      expect(level()).toBe(1.5);
      expect(cachedZoom()).toBe(1.5);
      expect(localStorage.getItem("gd-zoom")).toBe("1.5");
      // A later Reset now writes, since the disk holds 150%.
      resetZoom("action");
      expect(saveSettingsPatch).toHaveBeenLastCalledWith({ zoom: 1 });
    });

    it("C, L, W rejects: rolls back to the disk's level", async () => {
      const { load, write } = await startPreLoad();
      load.resolve(settings({ zoom: 1.5 }));
      await flush();
      expect(level()).toBe(1.1);
      write.reject(new Error("disk full"));
      await flush();
      expect(level()).toBe(1.5);
    });

    it("L, C: the choice stands", async () => {
      localStorage.setItem("gd-zoom", "1");
      vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
      await start();
      expect(level()).toBe(1.5);
      stepZoom(-1, "action");
      await flush();
      expect(level()).toBe(1.25);
      expect(saveSettingsPatch).toHaveBeenLastCalledWith({ zoom: 1.25 });
    });
  });

  it("stops writing unchanged commits once a write lands after a failed load", async () => {
    vi.mocked(loadSettings).mockRejectedValueOnce(new Error("unreadable"));
    await start();
    resetZoom("action");
    expect(saveSettingsPatch).toHaveBeenCalledTimes(1);
    await flush();
    resetZoom("action");
    expect(saveSettingsPatch).toHaveBeenCalledTimes(1);
  });

  it("heals a junk mirror to 100%", async () => {
    localStorage.setItem("gd-zoom", "150%");
    const load = deferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValueOnce(load.promise);
    await start();
    expect(level()).toBe(1);
  });

  it("keeps stepping, persisting and toasting when setZoom fails", async () => {
    tauri.setZoom.mockRejectedValue(new Error("no webview"));
    await start();
    stepZoom(1, "action");
    await flush();
    expect(level()).toBe(1.1);
    expect(saveSettingsPatch).toHaveBeenCalledWith({ zoom: 1.1 });
    expect(toast).toHaveBeenCalled();
    stepZoom(1, "action");
    expect(level()).toBe(1.25);
  });
});
