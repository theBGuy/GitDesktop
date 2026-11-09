/**
 * The app-wide GUI zoom controller: one level, persisted in settings, applied
 * through the webview's zoom factor, changed by the three zoom actions, zoom
 * in's Shift/numpad aliases, Ctrl/Cmd+wheel, the zoom toast's Reset action and
 * the Settings control. Native webview zoom stays off (tauri.conf.json leaves
 * zoomHotkeysEnabled unset), so these are the only zoom paths. React-free: no
 * hooks, no JSX.
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
  /** The SAVED level (the user's choice), above `level` while clamped. */
  saved: number;
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
let state: ZoomState = {
  level: ZOOM_DEFAULT,
  max: ZOOM_HARD_MAX,
  saved: ZOOM_DEFAULT,
};
let saved = ZOOM_DEFAULT;
let lastPersisted = ZOOM_DEFAULT;
// A persist that lands makes the disk value known; the reconcile's read must not
// replace it with an older one.
let persistLanded = false;
// Set once the store's read or a zoom write lands: until then the disk may hold
// another level than the mirror, so a commit equal to the current one persists.
let reconciled = false;
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
type Area = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };
// The last monitor pass's work area (physical px), null when unknown: without
// it a grow has nothing to bound it, so only the minimum applies.
let workArea: Area | null = null;
let monitorSeq = 0;
// Window geometry runs one reconcile at a time: a request during a run marks it
// dirty and the run loops once more, so no geometry call overtakes another.
let geometryDirty = false;
let geometryActive = false;
// Resize events seen, counted in the listener itself (not the debounced pass),
// so a grow can tell its size read went stale before setSize goes out.
let resizeSeq = 0;
// The minimum last sent, set once setMinSize resolves (a Tauri setter resolves
// once queued, not on the OS's acceptance); null after a failed send leaves the
// window's minimum unknown. It starts at tauri.conf.json's minimum, which
// scripts/zoom-steps.test.mjs pins to minWindowSizeFor(ZOOM_DEFAULT).
let sentMin: { width: number; height: number } | null =
  minWindowSizeFor(ZOOM_DEFAULT);
// Set by a raise that could grow the window; cleared once the move back on
// screen completes (moved, no move needed, or centre outside the area) or its
// retry is spent.
let placementOwed = false;
let placementTries = 0;
// The physical size and target of the last grow re-armed for a window left
// below the minimum. A platform that refuses it (an X11 tiling WM) answers with
// a configure, so a pass: none grows again until the size or target moves.
let refusedGrow: { size: Size; min: Size } | null = null;
// Zoom writes not yet settled; with persistLanded and the pending wheel write,
// tells the reconcile whether any user choice since launch can still reach the
// disk.
let writesInFlight = 0;
let toastSeq = 0;
let toastAt = Number.NEGATIVE_INFINITY;
// Whether the visible toast names the maximum, which a max-only change can
// make stale.
let toastNamesMax = false;
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

/** Publishes the applied level and max beside the saved level; returns whether
 *  the applied level moved, which the caller then applies. */
function setState(level: number, max: number): boolean {
  const moved = level !== state.level;
  if (!moved && max === state.max && saved === state.saved) return false;
  state = { level, max, saved };
  for (const listener of listeners) listener();
  return moved;
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

type Inner = { width: number; height: number; scale: number; physical: Size };

/** The inner size in logical px with its scale and the physical px it was
 *  read in, or null when a read fails or the scale moved around it: a DPI
 *  change between the size and scale reads would pair them across scales. */
async function readInner(): Promise<Inner | null> {
  const win = getCurrentWindow();
  try {
    const scale = await win.scaleFactor();
    const size = await win.innerSize();
    if ((await win.scaleFactor()) !== scale) return null;
    return {
      width: size.width / scale,
      height: size.height / scale,
      scale,
      physical: { width: size.width, height: size.height },
    };
  } catch {
    return null;
  }
}

/** Mirrors the dpi crate's round, which tao converts logical px to physical
 *  with: half away from zero. */
function roundPhysical(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** The physical size tao gives a logical one at this scale: for a minimum,
 *  the floor the OS holds the window at. */
function toPhysical(size: Size, scale: number): Size {
  return {
    width: roundPhysical(size.width * scale),
    height: roundPhysical(size.height * scale),
  };
}

const sameSize = (a: Size, b: Size) =>
  a.width === b.width && a.height === b.height;

/** Asks for a geometry reconcile. One runs at a time: a request made during a
 *  run makes it loop once more, against the target current then.
 *  Contract: every bound (the minimum for the applied level, no grow on an
 *  unknown display, no write while minimized, maximized or fullscreen) is
 *  checked against the most recent IPC reads. A native resize, move or DPI
 *  change between a read and the write it informs, the final round trip
 *  before a write included, can still breach one; closing that needs a
 *  native-side atomic command. */
function requestGeometry(): void {
  geometryDirty = true;
  if (!geometryActive) void runGeometry();
}

async function runGeometry(): Promise<void> {
  geometryActive = true;
  try {
    while (geometryDirty) {
      geometryDirty = false;
      // A failed step stays owed to the next request: retrying it inside this
      // run would spin against a failing IPC.
      await reconcileOnce().catch(() => undefined);
    }
  } finally {
    geometryActive = false;
  }
}

/** Brings the window to the current target: the minimum for the applied
 *  level, a grow of a window still below it (from a size read just before, so
 *  never a shrink), since macOS and GTK don't grow one themselves and a drag
 *  can swallow a grow, and the move back on screen a grow owes. A newer
 *  request seen before the minimum or the grow goes out ends the step, and the
 *  loop's next step serves the newer target; a grow already made is still
 *  moved back on screen unless the newest pass left the display unknown. */
async function reconcileOnce(): Promise<void> {
  const min = minWindowSizeFor(state.level);
  const area = workArea;
  // In physical px: tao floors the window at the minimum rounded at the read's
  // scale, which read back in logical px can sit a fraction under it.
  const below = (read: Inner | null) => {
    if (!read) return true;
    const floor = toPhysical(min, read.scale);
    return (
      read.physical.width < floor.width || read.physical.height < floor.height
    );
  };
  // An unknown minimum counts as a change: it may sit anywhere.
  const change = !sentMin || !sameSize(min, sentMin);
  // An unchanged minimum goes out only through a grow, which needs a known
  // display to bound it.
  if (!monitorAnswered || (!change && !area)) return;
  if (await isNotNormal()) return;
  const win = getCurrentWindow();
  if (change) {
    // Read before setMinSize: Windows grows a window below a new minimum
    // inside the call (tao set_min_inner_size), a lowered one included once a
    // drag left the window below the old, so this read decides the grow.
    const pre = await readInner();
    if (geometryDirty) return;
    const grows = below(pre);
    // On an unknown display nothing bounds a grow, native or explicit: a
    // change goes out only to a window that meets it, read again just before.
    if (!area) {
      // A resize during that read makes it stale; the resize's pass asks again.
      const resizes = resizeSeq;
      if (grows || below(await readInner()) || geometryDirty) return;
      if (resizeSeq !== resizes) return;
    }
    if (grows) {
      placementOwed = true;
      placementTries = 0;
    }
    refusedGrow = null;
    try {
      await win.setMinSize(new LogicalSize(min.width, min.height));
    } catch (error) {
      // The call may have reached the window before failing, so its minimum is
      // unknown and the next step sends the target whatever it is.
      sentMin = null;
      throw error;
    }
    sentMin = min;
  }
  if (!area) return;
  // Read again: it sees a native grow inside setMinSize, any resize since, and
  // a window left below the accepted minimum by a drag that swallowed a grow.
  const resizes = resizeSeq;
  const now = await readInner();
  if (!now || geometryDirty) return;
  const floor = toPhysical(min, now.scale);
  const short = {
    width: now.physical.width < floor.width,
    height: now.physical.height < floor.height,
  };
  if (!short.width && !short.height) refusedGrow = null;
  let rearmed = false;
  if (!placementOwed) {
    // With nothing owed, a window meeting the minimum takes no write, so a
    // pass after the user moves or parks the window never moves it.
    if (!below(now)) return;
    if (
      refusedGrow &&
      sameSize(refusedGrow.size, now.physical) &&
      sameSize(refusedGrow.min, min)
    )
      return;
    placementOwed = true;
    placementTries = 0;
    rearmed = true;
  }
  // A short axis takes the minimum, which tao rounds to the floor; the other
  // keeps the window's own size, so nothing shrinks.
  const grown = {
    width: short.width ? min.width : now.width,
    height: short.height ? min.height : now.height,
  };
  const grownPhysical = {
    width: short.width ? floor.width : now.physical.width,
    height: short.height ? floor.height : now.physical.height,
  };
  if (short.width || short.height) {
    // A resize since the read makes it stale, and a grow from it could shrink
    // the window: the resize's pass asks again. A move owed before stays owed
    // (no try spent); a re-arm made nothing owed.
    if (resizeSeq !== resizes) {
      if (rearmed) placementOwed = false;
      return;
    }
    await win.setSize(new LogicalSize(grown.width, grown.height));
    // Only a size read unchanged after the call counts as refused (i3 keeps
    // tao's cached size; Windows applies the grow at once, so a later
    // snap-back re-arms). A platform whose cached size lags records a false
    // refusal, which its configure clears through a read meeting the floor.
    // A snap-back landing before this read records one too (accepted).
    if (rearmed) {
      const after = await readInner();
      if (after && sameSize(after.physical, now.physical)) {
        refusedGrow = { size: now.physical, min };
      }
    }
  }
  // One retry after a failed move, then the move is dropped, so a window the
  // user parks partly off-screen after that retry is never pulled back. A park
  // between the failure and the retry (one debounced pass) can still be moved.
  // A deferred move spends no try.
  placementTries++;
  try {
    if (await keepOnScreen(grownPhysical, now.scale, area)) {
      placementOwed = false;
    } else placementTries--;
  } finally {
    if (placementTries > 1) placementOwed = false;
  }
}

/** A grow extends right and down from the top-left, so it can push the window
 *  past the work area: move it back, up and left first, never off the top-left.
 *  The work area is the last pass's, saving a monitor read per grow: a window
 *  whose centre lies outside it (moved to another monitor within the debounce,
 *  or parked mostly off-screen) is left in place, by a retried move too.
 *  Returns false, moving nothing, when a pass left the display unknown or
 *  changed its bounds, or the scale changed, during the position read, or the
 *  window left the normal state; that pass, or the one a scale or state change
 *  schedules, asks for another step, which re-reads everything.
 *  `inner` is in physical px, read at `scale`. */
async function keepOnScreen(
  inner: Size,
  scale: number,
  area: Area,
): Promise<boolean> {
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  // Read after the position: a scale change makes `inner` stale even where it
  // leaves the work area's physical bounds equal.
  if ((await win.scaleFactor()) !== scale) return false;
  // By value: every pass lands a new object, equal bounds included.
  const areaMoved = () =>
    !workArea ||
    workArea.x !== area.x ||
    workArea.y !== area.y ||
    workArea.width !== area.width ||
    workArea.height !== area.height;
  if (areaMoved()) return false;
  // Whole physical px: a float rebuild from logical px can land a hair over
  // the integer, and the far-edge bound would then nudge a flush window.
  const outerWidth = inner.width + roundPhysical(frame.width * scale);
  const outerHeight = inner.height + roundPhysical(frame.height * scale);
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
    return true;
  const x = Math.max(area.x, Math.min(pos.x, area.x + area.width - outerWidth));
  const y = Math.max(
    area.y,
    Math.min(pos.y, area.y + area.height - outerHeight),
  );
  if (x === pos.x && y === pos.y) return true;
  // Re-checked last, right before the move: a maximize since the step began
  // would have this place the maximized window.
  if ((await isNotNormal()) || areaMoved()) return false;
  await win.setPosition(new PhysicalPosition(x, y));
  return true;
}

function applyLevel(level: number): void {
  void tauri(() => getCurrentWebview().setZoom(level));
  if (monitorAnswered) requestGeometry();
}

/** A rejected read counts as an answer too, as a failed monitor read does, so
 *  the deferred min size applies on the next change; an overtaken pass's
 *  rejection doesn't: the newer pass answers, or skips while minimized and
 *  leaves the answer to a later one. The answer is an unknown display with the
 *  last max kept: an older pass's work area must not bound a grow, so a run in
 *  flight is told to re-check, as a null answer does. */
async function evaluateMonitor(): Promise<void> {
  // Passes overlap (each awaits several reads); only the newest one lands.
  const seq = ++monitorSeq;
  try {
    await monitorPass(seq);
  } catch (error) {
    if (seq === monitorSeq) {
      monitorAnswered = true;
      workArea = null;
      requestGeometry();
    }
    throw error;
  }
}

/** Re-reads the monitor's work area and clamps the APPLIED level to what it
 *  fits; the saved level is never rewritten, so a bigger monitor restores it. */
async function monitorPass(seq: number): Promise<void> {
  const win = getCurrentWindow();
  // A minimized window sits off-screen (-32000 on Windows), where the monitor
  // read can answer for the wrong display: skip the whole pass.
  if (await win.isMinimized()) return;
  const [monitor, notNormal] = await Promise.all([
    currentMonitor().catch(() => null),
    isNotNormal(),
  ]);
  if (seq !== monitorSeq) return;
  if (!notNormal) {
    // The outer size counts only between equal inner and scale reads, as a
    // non-negative frame; a resize or DPI change across it keeps the last one.
    const scale = await win.scaleFactor();
    const before = await win.innerSize();
    const outer = await win.outerSize();
    const inner = await win.innerSize();
    const torn =
      !sameSize(before, inner) || (await win.scaleFactor()) !== scale;
    if (seq !== monitorSeq) return;
    const width = outer.width - inner.width;
    const height = outer.height - inner.height;
    if (!torn && width >= 0 && height >= 0) {
      frame = { width: width / scale, height: height / scale };
    }
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
  workArea = monitor
    ? {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      }
    : null;
  const level = Math.min(saved, max);
  // A toast up would name the old level; only a maximum toast names the max,
  // so a max-only change leaves a plain or minimum toast up.
  const stale = level !== state.level || (max !== state.max && toastNamesMax);
  if (setState(level, max)) applyLevel(level);
  // Also catches up a change made while not normal or before the first answer,
  // and a raise held for an unknown display: un-maximize and fullscreen exit
  // re-run this pass.
  else requestGeometry();
  if (stale) dismissToast();
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
  writesInFlight++;
  saveSettingsPatch({ zoom: value }).then(
    () => {
      writesInFlight--;
      lastPersisted = value;
      persistLanded = true;
      // The disk now holds this session's value, so an equal commit can skip.
      reconciled = true;
      // Another settings write's seed or refetch may have landed an older zoom.
      patchCachedZoom(saved);
    },
    (error: unknown) => {
      writesInFlight--;
      if (gen !== generation) return;
      saved = lastPersisted;
      writeMirror(saved);
      patchCachedZoom(saved);
      // The applied level follows now, with the toast, not on the next move.
      const level = Math.min(saved, state.max);
      if (setState(level, state.max)) applyLevel(level);
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
  toastNamesMax = suffix !== "" && suffix !== MIN_SUFFIX;
  const id = currentToastId();
  toast(`Zoom ${formatZoom(level)}${suffix}`, {
    id,
    // sonner's own close (timer, hover-shortened timer, swipe) retires the id,
    // so the next step opens a fresh toast instead of a dropped update.
    onAutoClose: markToastClosed,
    onDismiss: markToastClosed,
    duration: TOAST_MS,
    // Explicit even when absent: sonner merges an in-place update into the
    // previous toast, so a missing key would keep the last Reset. Offered on
    // the same terms as Settings' Reset, so a clamped saved level gets it.
    action:
      level === ZOOM_DEFAULT && saved === ZOOM_DEFAULT
        ? undefined
        : {
            label: "Reset",
            // sonner deletes the toast after an action without calling either
            // close callback, so the reset's own toast must take a fresh id.
            onClick: () => {
              markToastClosed({ id });
              resetZoom("action");
            },
          },
  });
}

const MIN_SUFFIX = " · minimum";

function limitSuffix(level: number): string {
  if (level <= ZOOM_MIN) return MIN_SUFFIX;
  return state.max < ZOOM_HARD_MAX
    ? " · maximum for this display"
    : " · maximum";
}

function commit(level: number, source: ZoomSource): void {
  // The final value always lands: a pending wheel write goes out before this one.
  if (source !== "wheel") flushWheelPersist();
  const unchanged = reconciled && level === saved && level === state.level;
  if (!unchanged) {
    generation++;
    saved = level;
    writeMirror(level);
    patchCachedZoom(level);
    if (setState(level, state.max)) applyLevel(level);
    persist(source);
  }
  if (source !== "settings") showToast(level);
  else dismissToast();
}

function markToastClosed(closed: { id: number | string }): void {
  if (closed.id === currentToastId()) toastAt = Number.NEGATIVE_INFINITY;
}

/** A Settings change, a rejected persist, and a non-user publish that moves the
 *  applied or saved level (the Reset offer follows the saved one), or the max
 *  under a maximum toast (the only toast that names it), retire the zoom toast. */
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
  state = { level: saved, max: ZOOM_HARD_MAX, saved };
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
    () =>
      getCurrentWindow().onResized(() => {
        resizeSeq++;
        scheduleMonitor();
      }),
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
      reconciled = true;
      if (!persistLanded) lastPersisted = settings.zoom;
      // A user change made while this read was in flight wins while it can
      // still reach the disk; once every one failed, the disk's value stands.
      const choicePending =
        persistLanded || writesInFlight > 0 || wheelPersistTimer !== undefined;
      if (gen !== generation && choicePending) return;
      const savedMoved = settings.zoom !== saved;
      saved = settings.zoom;
      writeMirror(saved);
      patchCachedZoom(saved);
      const level = Math.min(saved, state.max);
      const moved = setState(level, state.max);
      if (moved) applyLevel(level);
      if (moved || savedMoved) dismissToast();
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

/** Lists that pick items with Ctrl/Cmd+click, where Ctrl/Cmd+scroll scrolls. */
const MULTISELECT_LIST = '[aria-multiselectable="true"], [data-multiselect]';
const WHEEL_LINE_PX = 16;

const SCROLL_AXES = {
  y: {
    size: "scrollHeight",
    client: "clientHeight",
    overflow: "overflowY",
    offset: "scrollTop",
  },
  x: {
    size: "scrollWidth",
    client: "clientWidth",
    overflow: "overflowX",
    offset: "scrollLeft",
  },
} as const;

/** Scrolls the nearest box from `target` up to `list` that scrolls on `axis`
 *  by `delta`, each step capped at the box's visible size as Chromium caps a
 *  wheel notch. A list with no such box takes nothing. */
function scrollAxis(
  delta: number,
  mode: number,
  target: Element,
  list: Element,
  axis: keyof typeof SCROLL_AXES,
): void {
  if (delta === 0) return;
  const { size, client, overflow, offset } = SCROLL_AXES[axis];
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el instanceof HTMLElement && el[size] > el[client]) {
      const style = getComputedStyle(el)[overflow];
      if (style === "auto" || style === "scroll") {
        let unit = 1;
        if (mode === WheelEvent.DOM_DELTA_LINE) unit = WHEEL_LINE_PX;
        if (mode === WheelEvent.DOM_DELTA_PAGE) unit = el[client];
        const step = delta * unit;
        el[offset] += Math.sign(step) * Math.min(Math.abs(step), el[client]);
        return;
      }
    }
    if (el === list) return;
  }
}

/** Scrolls a multi-select list by the wheel's deltas: with zoomHotkeysEnabled
 *  off, WebView2 doesn't scroll a Ctrl+wheel natively. */
function scrollList(e: WheelEvent, target: Element, list: Element): void {
  scrollAxis(e.deltaY, e.deltaMode, target, list, "y");
  scrollAxis(e.deltaX, e.deltaMode, target, list, "x");
}

function onWheel(e: WheelEvent): void {
  // First, before any work: every wheel event waits on this listener.
  if (!isModWheel(e)) return;
  e.preventDefault();
  // Over a multi-select list the gesture scrolls, leaving the zoom
  // accumulation alone.
  const list =
    e.target instanceof Element ? e.target.closest(MULTISELECT_LIST) : null;
  if (list) {
    scrollList(e, e.target as Element, list);
    return;
  }
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
    }
  }
  if (direction === 0) return;
  // Any step, line and page mode included, starts a fresh accumulation.
  wheelRemainder = 0;
  stepZoom(direction, "wheel");
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

/** Test-only: the work area the newest landed pass left, null when unknown. */
export function __zoomWorkAreaForTests(): Area | null {
  return workArea;
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
  state = { level: ZOOM_DEFAULT, max: ZOOM_HARD_MAX, saved: ZOOM_DEFAULT };
  saved = ZOOM_DEFAULT;
  lastPersisted = ZOOM_DEFAULT;
  persistLanded = false;
  reconciled = false;
  generation = 0;
  monitorAnswered = false;
  frame = { width: 0, height: 0 };
  workArea = null;
  monitorSeq = 0;
  geometryDirty = false;
  geometryActive = false;
  resizeSeq = 0;
  sentMin = minWindowSizeFor(ZOOM_DEFAULT);
  placementOwed = false;
  placementTries = 0;
  refusedGrow = null;
  writesInFlight = 0;
  toastSeq = 0;
  toastAt = Number.NEGATIVE_INFINITY;
  toastNamesMax = false;
  wheelRemainder = 0;
  listeners.clear();
}
