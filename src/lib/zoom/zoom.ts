/**
 * The app-wide GUI zoom controller: one level, persisted in settings, applied
 * through the webview's zoom factor, changed by the three zoom actions, their
 * Shift/numpad aliases, Ctrl/Cmd+wheel and the Settings control. Native webview
 * zoom stays off (tauri.conf.json leaves zoomHotkeysEnabled unset), so these
 * listeners are the only zoom path. React-free: no hooks, no JSX.
 */
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import {
  eventToBinding,
  firesInEditable,
  hasModifier,
  isEditableTarget,
  isModWheel,
  isTypeaheadKey,
  isTypeaheadTarget,
} from "@/lib/hotkeys/binding";
import {
  type HandlerEntry,
  registerHandler,
  unregisterHandler,
} from "@/lib/hotkeys/handler-registry";
import { ACTIONS, type ActionId } from "@/lib/hotkeys/registry";
import { queryClient } from "@/lib/query-client";
import {
  type AppSettings,
  loadSettings,
  saveSettingsPatch,
} from "@/lib/settings/api";
import { settingsKeys } from "@/lib/settings/queries";
import { toastErrorWithNote } from "@/lib/toast";
import {
  formatZoom,
  healZoom,
  maxZoomForArea,
  minWindowSizeFor,
  nextZoomStep,
  ZOOM_DEFAULT,
  ZOOM_HARD_MAX,
  ZOOM_MIN,
} from "./steps";

export type ZoomSource = "settings" | "action" | "wheel";

export interface ZoomState {
  /** The APPLIED level; below the saved one while the monitor can't fit it. */
  level: number;
  /** The current monitor-bounded maximum. */
  max: number;
}

/** Holds the SAVED level (the user's choice), never a monitor-clamped one. */
const LS_KEY = "gd-zoom";
const TOAST_ID = "app-zoom";
const TOAST_MS = 2000;
/** sonner starts a toast's ~200 ms exit at its duration and drops updates made
 *  to it from then on. Its close callbacks retire the id; this margin backs
 *  them up for a step landing before the callback has run. */
const TOAST_FRESH_MARGIN_MS = 250;
const WHEEL_PERSIST_MS = 300;
const WHEEL_IDLE_MS = 250;
/** Pixel wheel delta per step: one WebView2 notch (100, or 100/zoom up to 200%)
 *  is one step, while trackpad deltas accumulate. */
const WHEEL_STEP_PX = 50;
const MONITOR_DEBOUNCE_MS = 200;
/** Shift+= on US layouts and numpad add, which report "+" as the key. */
const ZOOM_IN_ALIASES = new Set(["mod+shift++", "mod++"]);

let initialized = false;
let state: ZoomState = { level: ZOOM_DEFAULT, max: ZOOM_HARD_MAX };
let saved = ZOOM_DEFAULT;
let lastPersisted = ZOOM_DEFAULT;
// A persist that lands makes the disk value known; the reconcile's read must not
// replace it with an older one.
let persistLanded = false;
// Bumped by every user change; the reconcile and a rejected persist only act
// when no newer change started.
let generation = 0;
const listeners = new Set<() => void>();
// The min-size path waits for the first monitor answer: a saved 150% applied
// before it would grow a small laptop's window past its screen for good.
let monitorAnswered = false;
// Window frame (outer − inner, logical) from the last normal-state read, so a
// minimized or maximized window's geometry never skews the area math.
let frame = { width: 0, height: 0 };
// The last monitor pass's work area (physical px), null when unknown: without
// it a grow has nothing to bound it, so only the minimum applies.
let workArea: { x: number; y: number; width: number; height: number } | null =
  null;
let monitorSeq = 0;
let applySeq = 0;
// The minimum last applied: tao's set_min_inner_size re-sets the window size
// (a SetWindowPos on Windows) every call, so an unchanged minimum is skipped.
// Cleared while the window isn't normal, so leaving maximized re-applies it.
let appliedMin: { width: number; height: number } | null = null;
let toastSeq = 0;
let toastAt = Number.NEGATIVE_INFINITY;
let wheelRemainder = 0;
let wheelIdleTimer: ReturnType<typeof setTimeout> | undefined;
let wheelPersistTimer: ReturnType<typeof setTimeout> | undefined;
let monitorTimer: ReturnType<typeof setTimeout> | undefined;
let teardown: Array<() => void> = [];

/** Runs a Tauri call so neither a sync throw nor a rejection breaks zooming:
 *  set_zoom resolves on send, and platform failures are only logged. */
function tauri<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return call().catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function setState(level: number, max: number): void {
  if (level === state.level && max === state.max) return;
  state = { level, max };
  for (const listener of listeners) listener();
}

function writeMirror(level: number): void {
  try {
    localStorage.setItem(LS_KEY, String(level));
  } catch {
    // A locked-down webview can throw on localStorage; the settings store stays
    // the source of truth, so the cost is the default level until it loads.
  }
}

function readMirror(): number {
  try {
    const stored = localStorage.getItem(LS_KEY);
    return stored === null ? ZOOM_DEFAULT : healZoom(Number(stored));
  } catch {
    return ZOOM_DEFAULT;
  }
}

function patchCachedZoom(zoom: number): void {
  const cached = queryClient.getQueryData<AppSettings>(settingsKeys.settings);
  if (cached && cached.zoom !== zoom) {
    queryClient.setQueryData(settingsKeys.settings, { ...cached, zoom });
  }
}

async function isNotNormal(): Promise<boolean> {
  const win = getCurrentWindow();
  const flags = await Promise.all([
    win.isMinimized(),
    win.isMaximized(),
    win.isFullscreen(),
  ]);
  return flags.some(Boolean);
}

/** Raises the window minimum to the zoomed layout floor and grows (never
 *  shrinks) a window below it: macOS and GTK don't grow it themselves. */
async function applyMinSize(level: number): Promise<void> {
  const seq = ++applySeq;
  const notNormal = await isNotNormal();
  if (notNormal) appliedMin = null;
  if (notNormal || seq !== applySeq) return;
  const win = getCurrentWindow();
  const min = minWindowSizeFor(level);
  if (
    appliedMin &&
    appliedMin.width === min.width &&
    appliedMin.height === min.height
  )
    return;
  // Recorded before the await so an overlapping call skips; a failure clears it.
  appliedMin = min;
  try {
    await win.setMinSize(new LogicalSize(min.width, min.height));
  } catch (error) {
    if (appliedMin === min) appliedMin = null;
    throw error;
  }
  if (!workArea) return;
  const [inner, scale] = await Promise.all([
    win.innerSize(),
    win.scaleFactor(),
  ]);
  if (seq !== applySeq) return;
  const width = inner.width / scale;
  const height = inner.height / scale;
  if (width < min.width || height < min.height) {
    const grown = {
      width: Math.max(width, min.width),
      height: Math.max(height, min.height),
    };
    await win.setSize(new LogicalSize(grown.width, grown.height));
    await keepOnScreen(grown, scale, seq);
  }
}

/** A grow extends right and down from the top-left, so it can push the window
 *  past the work area: move it back, up and left first, never off the top-left.
 *  The work area is the last pass's; a window whose centre left it has moved
 *  to another monitor since, and is left where it is (the move's own pass
 *  re-reads), rather than paying a fresh monitor read on every grow. */
async function keepOnScreen(
  inner: { width: number; height: number },
  scale: number,
  seq: number,
): Promise<void> {
  const area = workArea;
  if (!area) return;
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  if (seq !== applySeq) return;
  const outerWidth = (inner.width + frame.width) * scale;
  const outerHeight = (inner.height + frame.height) * scale;
  // The centre, not the corner: a snapped window's corner sits a few px
  // outside the work area (Windows' invisible resize borders).
  const centreX = pos.x + outerWidth / 2;
  const centreY = pos.y + outerHeight / 2;
  if (
    centreX < area.x ||
    centreX >= area.x + area.width ||
    centreY < area.y ||
    centreY >= area.y + area.height
  )
    return;
  // Tauri takes an i32 PhysicalPosition, and a fractional scale makes the outer
  // size fractional: flooring the far-edge bound keeps x/y whole and in the area.
  const x = Math.max(
    area.x,
    Math.min(pos.x, Math.floor(area.x + area.width - outerWidth)),
  );
  const y = Math.max(
    area.y,
    Math.min(pos.y, Math.floor(area.y + area.height - outerHeight)),
  );
  if (x === pos.x && y === pos.y) return;
  await win.setPosition(new PhysicalPosition(x, y));
}

function applyLevel(level: number): void {
  void tauri(() => getCurrentWebview().setZoom(level));
  if (monitorAnswered) void tauri(() => applyMinSize(level));
}

/** Re-reads the monitor's work area and clamps the APPLIED level to what it
 *  fits; the saved level is never rewritten, so a bigger monitor restores it. */
async function evaluateMonitor(): Promise<void> {
  // Passes overlap (each awaits several reads); only the newest one lands.
  const seq = ++monitorSeq;
  const win = getCurrentWindow();
  // A minimized window sits off-screen (-32000 on Windows), where the monitor
  // read can answer for the wrong display: skip the whole pass.
  if (await win.isMinimized()) {
    appliedMin = null;
    return;
  }
  const [monitor, notNormal] = await Promise.all([
    currentMonitor().catch(() => null),
    isNotNormal(),
  ]);
  if (seq !== monitorSeq) return;
  if (notNormal) appliedMin = null;
  else {
    const [outer, inner, scale] = await Promise.all([
      win.outerSize(),
      win.innerSize(),
      win.scaleFactor(),
    ]);
    if (seq !== monitorSeq) return;
    frame = {
      width: (outer.width - inner.width) / scale,
      height: (outer.height - inner.height) / scale,
    };
  }
  // A failed or empty read still counts as an answer, so the deferred min size
  // applies; it keeps the last max (never a defaulted lower clamp) until the
  // next move, resize or scale change reads again.
  const max = monitor
    ? maxZoomForArea(
        monitor.workArea.size.width / monitor.scaleFactor - frame.width,
        monitor.workArea.size.height / monitor.scaleFactor - frame.height,
      )
    : state.max;
  monitorAnswered = true;
  // A minimum set while the area was unknown skipped its grow; forgetting it
  // lets this pass grow a window still below it.
  if (monitor && !workArea) appliedMin = null;
  workArea = monitor
    ? {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      }
    : null;
  const level = Math.min(saved, max);
  const changed = level !== state.level;
  setState(level, max);
  if (changed) applyLevel(level);
  // Also catches up a change made while maximized or fullscreen, or before the
  // first answer: un-maximize and fullscreen exit re-run this pass.
  else void tauri(() => applyMinSize(level));
}

function scheduleMonitor(): void {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(() => {
    void tauri(evaluateMonitor);
  }, MONITOR_DEBOUNCE_MS);
}

function writeSaved(): void {
  const value = saved;
  const gen = generation;
  saveSettingsPatch({ zoom: value }).then(
    () => {
      lastPersisted = value;
      persistLanded = true;
      // Another settings write's seed or refetch may have landed an older zoom.
      patchCachedZoom(saved);
    },
    (error: unknown) => {
      if (gen !== generation) return;
      saved = lastPersisted;
      writeMirror(saved);
      patchCachedZoom(saved);
      // The applied level follows now, with the toast, not on the next move.
      const level = Math.min(saved, state.max);
      if (level !== state.level) {
        setState(level, state.max);
        applyLevel(level);
      }
      dismissToast();
      toastErrorWithNote(
        error,
        `Couldn't save the zoom level; it's back at ${formatZoom(level)}.`,
      );
    },
  );
}

function flushWheelPersist(): void {
  if (wheelPersistTimer === undefined) return;
  clearTimeout(wheelPersistTimer);
  wheelPersistTimer = undefined;
  writeSaved();
}

function persist(source: ZoomSource): void {
  if (source !== "wheel") {
    writeSaved();
    return;
  }
  clearTimeout(wheelPersistTimer);
  wheelPersistTimer = setTimeout(() => {
    wheelPersistTimer = undefined;
    writeSaved();
  }, WHEEL_PERSIST_MS);
}

function currentToastId(): string {
  return `${TOAST_ID}-${toastSeq}`;
}

function showToast(level: number, suffix = ""): void {
  const now = Date.now();
  // Rapid steps update one toast in place; a step after sonner closed it, or
  // near its nominal end, opens a fresh one instead.
  if (now - toastAt >= TOAST_MS - TOAST_FRESH_MARGIN_MS) {
    if (Number.isFinite(toastAt)) toast.dismiss(currentToastId());
    toastSeq++;
  }
  toastAt = now;
  toast(`Zoom ${formatZoom(level)}${suffix}`, {
    id: currentToastId(),
    // sonner's own close (timer, hover-shortened timer, swipe, action) retires
    // the id, so the next step opens a fresh toast instead of a dropped update.
    onAutoClose: markToastClosed,
    onDismiss: markToastClosed,
    duration: TOAST_MS,
    // Explicit even when absent: sonner merges an in-place update into the
    // previous toast, so a missing key would keep the last Reset.
    action:
      level === ZOOM_DEFAULT
        ? undefined
        : { label: "Reset", onClick: () => resetZoom("action") },
  });
}

function limitSuffix(level: number): string {
  if (level <= ZOOM_MIN) return " · minimum";
  return state.max < ZOOM_HARD_MAX
    ? " · maximum for this display"
    : " · maximum";
}

function commit(level: number, source: ZoomSource): void {
  // The final value always lands: a pending wheel write goes out before this one.
  if (source !== "wheel") flushWheelPersist();
  const unchanged = level === saved && level === state.level;
  if (!unchanged) {
    generation++;
    saved = level;
    writeMirror(level);
    patchCachedZoom(level);
    if (level !== state.level) {
      setState(level, state.max);
      applyLevel(level);
    }
    persist(source);
  }
  if (source !== "settings") showToast(level);
  else dismissToast();
}

function markToastClosed(closed: { id: number | string }): void {
  if (closed.id === currentToastId()) toastAt = Number.NEGATIVE_INFINITY;
}

/** A Settings change retires the zoom toast, whose level it no longer shows. */
function dismissToast(): void {
  if (!Number.isFinite(toastAt)) return;
  toast.dismiss(currentToastId());
  toastAt = Number.NEGATIVE_INFINITY;
}

export function initZoom(): void {
  if (initialized) return;
  initialized = true;
  saved = readMirror();
  lastPersisted = saved;
  state = { level: saved, max: ZOOM_HARD_MAX };
  applyLevel(saved);

  // CAPTURE so a target that stops propagation (a terminal) can't swallow
  // Ctrl+wheel; non-passive because root wheel listeners default passive.
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  // BUBBLE on purpose: the shortcut recorder swallows keys in capture.
  window.addEventListener("keydown", onAliasKeyDown);
  teardown.push(() => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("keydown", onAliasKeyDown);
  });

  // Module-level so the actions answer on every screen, welcome included.
  const handlers: Array<[ActionId, HandlerEntry]> = [
    ["app-zoom-in", { run: () => stepZoom(1, "action"), enabled: true }],
    ["app-zoom-out", { run: () => stepZoom(-1, "action"), enabled: true }],
    ["app-zoom-reset", { run: () => resetZoom("action"), enabled: true }],
  ];
  for (const [id, entry] of handlers) {
    registerHandler(id, entry);
    teardown.push(() => unregisterHandler(id, entry));
  }

  for (const listen of [
    () => getCurrentWindow().onMoved(scheduleMonitor),
    () => getCurrentWindow().onResized(scheduleMonitor),
    () => getCurrentWindow().onScaleChanged(scheduleMonitor),
  ]) {
    void tauri(listen).then((unlisten) => {
      if (!unlisten) return;
      if (initialized) teardown.push(unlisten);
      else unlisten();
    });
  }
  void tauri(evaluateMonitor);

  const gen = generation;
  void loadSettings()
    .then((settings) => {
      if (!persistLanded) lastPersisted = settings.zoom;
      // A user change made while this read was in flight wins.
      if (gen !== generation) return;
      saved = settings.zoom;
      writeMirror(saved);
      const level = Math.min(saved, state.max);
      if (level !== state.level) {
        setState(level, state.max);
        applyLevel(level);
      }
    })
    .catch(() => {
      // The mirror's level stays applied; the next user change persists.
    });
}

export function getZoomState(): ZoomState {
  return state;
}

export function subscribeZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setZoomLevel(level: number, source: ZoomSource): void {
  commit(Math.min(healZoom(level), state.max), source);
}

export function stepZoom(direction: 1 | -1, source: ZoomSource): void {
  const next = nextZoomStep(state.level, direction, state.max);
  if (next === state.level) {
    // Past a limit: nothing changes or persists; the toast names the limit.
    if (source !== "settings") showToast(next, limitSuffix(next));
    return;
  }
  commit(next, source);
}

export function resetZoom(source: ZoomSource): void {
  setZoomLevel(ZOOM_DEFAULT, source);
}

function onWheel(e: WheelEvent): void {
  // First, before any work: every wheel event waits on this listener.
  if (!isModWheel(e)) return;
  e.preventDefault();
  clearTimeout(wheelIdleTimer);
  wheelIdleTimer = setTimeout(() => {
    wheelRemainder = 0;
  }, WHEEL_IDLE_MS);
  let direction: 1 | -1 | 0 = 0;
  if (e.deltaMode >= 1) {
    direction = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
  } else {
    // A reversal starts a fresh accumulation rather than unwinding the old one.
    if (e.deltaY * wheelRemainder < 0) wheelRemainder = 0;
    wheelRemainder += e.deltaY;
    if (Math.abs(wheelRemainder) >= WHEEL_STEP_PX) {
      direction = wheelRemainder < 0 ? 1 : -1;
      wheelRemainder = 0;
    }
  }
  if (direction !== 0) stepZoom(direction, "wheel");
}

/** The binding each action answers to now: the user's override, else the default. */
function effectiveBinding(
  id: ActionId,
  hotkeys: AppSettings["hotkeys"] | undefined,
) {
  const override = hotkeys?.[id];
  const action = ACTIONS.find((a) => a.id === id);
  return override === undefined ? (action?.defaultBinding ?? null) : override;
}

function onAliasKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.repeat) return;
  const binding = eventToBinding(e);
  if (!binding || !ZOOM_IN_ALIASES.has(binding)) return;
  // The global listener's guard clause, so the two dispatchers can't drift.
  if (isEditableTarget(e.target) && !firesInEditable(binding)) return;
  if (
    !hasModifier(binding) &&
    isTypeaheadKey(binding) &&
    isTypeaheadTarget(e.target)
  )
    return;
  const hotkeys = queryClient.getQueryData<AppSettings>(
    settingsKeys.settings,
  )?.hotkeys;
  // Aliases ride zoom-in's default chord only, and yield to any action bound to
  // the alias itself.
  if (effectiveBinding("app-zoom-in", hotkeys) !== "mod+=") return;
  if (ACTIONS.some((a) => effectiveBinding(a.id, hotkeys) === binding)) return;
  e.preventDefault();
  stepZoom(1, "action");
}

/** Test-only: removes the listeners and handlers, and resets all state. */
export function __resetZoomForTests(): void {
  for (const undo of teardown) undo();
  teardown = [];
  clearTimeout(wheelIdleTimer);
  clearTimeout(wheelPersistTimer);
  clearTimeout(monitorTimer);
  wheelIdleTimer = undefined;
  wheelPersistTimer = undefined;
  monitorTimer = undefined;
  initialized = false;
  state = { level: ZOOM_DEFAULT, max: ZOOM_HARD_MAX };
  saved = ZOOM_DEFAULT;
  lastPersisted = ZOOM_DEFAULT;
  persistLanded = false;
  generation = 0;
  monitorAnswered = false;
  frame = { width: 0, height: 0 };
  workArea = null;
  monitorSeq = 0;
  applySeq = 0;
  appliedMin = null;
  toastSeq = 0;
  toastAt = Number.NEGATIVE_INFINITY;
  wheelRemainder = 0;
  listeners.clear();
}
