import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAction, hasLiveHandler } from "@/lib/hotkeys/handler-registry";
import { queryClient } from "@/lib/query-client";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { toastErrorWithNote } from "@/lib/toast";
import {
  __resetZoomForTests,
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
    currentMonitor: vi.fn(),
    moved: [] as Array<() => void>,
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
const minSizes = () =>
  tauri.setMinSize.mock.calls.map(([s]) => [s.width, s.height]);

async function start() {
  initZoom();
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  tauri.moved = [];
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
    return () => undefined;
  });
  tauri.onResized.mockImplementation(async (cb: () => void) => {
    tauri.moved.push(cb);
    return () => undefined;
  });
  tauri.onScaleChanged.mockResolvedValue(() => undefined);
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

  it("moves a grown window back inside the work area, up first", async () => {
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
    // The 907.5×830.25 outer rect would land at y 469.75 unrounded.
    const [moved] = tauri.setPosition.mock.calls.at(-1) ?? [];
    expect(Number.isInteger(moved.x) && Number.isInteger(moved.y)).toBe(true);
    expect([moved.x, moved.y]).toEqual([100, 469]);
    expect(moved.y + (625 + 39.2) * 1.25).toBeLessThanOrEqual(1300);
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
    // Negative control: a further known pass at the same level stays skipped.
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

describe("monitor clamp", () => {
  it("clamps the applied level without rewriting the saved one, and restores it", async () => {
    localStorage.setItem("gd-zoom", "1.5");
    vi.mocked(loadSettings).mockResolvedValue(settings({ zoom: 1.5 }));
    queryClient.setQueryData(settingsKeys.settings, settings({ zoom: 1.5 }));
    tauri.currentMonitor.mockResolvedValue(monitor(900, 700));
    await start();
    // 900×700 minus the 16×39 frame fits 125% but not 150%.
    expect(getZoomState()).toEqual({ level: 1.25, max: 1.25 });
    expect(saveSettingsPatch).not.toHaveBeenCalled();
    expect(cachedZoom()).toBe(1.5);
    expect(localStorage.getItem("gd-zoom")).toBe("1.5");

    tauri.currentMonitor.mockResolvedValue(monitor(3840, 2160));
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(getZoomState()).toEqual({ level: 1.5, max: 2 });
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
      expect(getZoomState()).toEqual({ level: 1.5, max: 2 });
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

  it("sets an unchanged minimum once, and again after a not-normal pass", async () => {
    await start();
    expect(minSizes()).toEqual([[640, 600]]);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(tauri.setMinSize).toHaveBeenCalledTimes(1);
    // The second pass reads only the frame: no grow read either.
    expect(tauri.innerSize).toHaveBeenCalledTimes(3);
    tauri.isMaximized.mockResolvedValue(true);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(tauri.setMinSize).toHaveBeenCalledTimes(1);
    tauri.isMaximized.mockResolvedValue(false);
    for (const cb of tauri.moved) cb();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(minSizes()).toEqual([
      [640, 600],
      [640, 600],
    ]);
  });

  it("sets the minimum but never grows the window when the monitor is unknown", async () => {
    tauri.innerSize.mockResolvedValue(tauri.size(700, 600));
    tauri.currentMonitor.mockResolvedValue(null);
    await start();
    setZoomLevel(1.25, "action");
    await flush();
    expect(minSizes().at(-1)).toEqual([710, 625]);
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
    expect(getZoomState()).toEqual({ level: 1, max: 2 });
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
    load.resolve(settings({ zoom: 1.75 }));
    await flush();
    expect(level()).toBe(1.75);
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
