// The GUI zoom's pure math. Import-free on purpose: heal.ts and the no-install
// node suite (scripts/zoom-steps.test.mjs) load it straight from src/.

/** The zoom levels the app steps through, identical on every platform. */
export const ZOOM_STEPS: readonly number[] = [
  0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];
export const ZOOM_DEFAULT = 1;
export const ZOOM_MIN = 0.8;
export const ZOOM_HARD_MAX = 2;
/** The smallest viewport (CSS px at 100%) every surface still lays out in,
 *  measured; the window floor scales with the zoom from this. */
const ZOOM_LAYOUT_FLOOR = { width: 568, height: 500 } as const;

/** tauri.conf.json's minWidth/minHeight, which no zoom level goes below. */
const WINDOW_MIN = { width: 640, height: 600 } as const;

// Float products like 500 × 1.1 land a hair above the integer they mean, so a
// plain ceil would ask for one pixel more than the layout needs.
const ceilPx = (n: number) => Math.ceil(n - 1e-9);

/** The nearest step to a saved value; ties round DOWN. Non-numbers, non-finite
 *  and non-positive values are junk and heal to the default. */
export function healZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return ZOOM_DEFAULT;
  }
  let best = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    // Strictly closer by more than float noise, so an exact tie keeps the lower.
    if (Math.abs(step - value) < Math.abs(best - value) - 1e-9) best = step;
  }
  return best;
}

/** The largest step at or below `max`, never below ZOOM_MIN. */
function capStep(max: number): number {
  let cap = ZOOM_MIN;
  for (const step of ZOOM_STEPS) if (step <= max + 1e-9) cap = step;
  return cap;
}

/** One step from `level` (snapped first) toward `direction`, within
 *  [ZOOM_MIN, max]; at a limit, the current clamped step. */
export function nextZoomStep(
  level: number,
  direction: 1 | -1,
  max: number,
): number {
  const cap = capStep(max);
  const current = Math.min(healZoom(level), cap);
  const i = ZOOM_STEPS.indexOf(current);
  const j = Math.min(Math.max(i + direction, 0), ZOOM_STEPS.length - 1);
  return Math.min(ZOOM_STEPS[j], cap);
}

/** The largest step whose layout floor fits a logical area, capped at
 *  ZOOM_HARD_MAX and never below ZOOM_DEFAULT. */
export function maxZoomForArea(
  logicalWidth: number,
  logicalHeight: number,
): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i];
    if (step > ZOOM_HARD_MAX || step < ZOOM_DEFAULT) continue;
    if (
      ceilPx(ZOOM_LAYOUT_FLOOR.width * step) <= logicalWidth &&
      ceilPx(ZOOM_LAYOUT_FLOOR.height * step) <= logicalHeight
    ) {
      return step;
    }
  }
  return ZOOM_DEFAULT;
}

/** The window's logical minimum size at `level`: the layout floor scaled by the
 *  zoom, never below the configured window minimum. */
export function minWindowSizeFor(level: number): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(WINDOW_MIN.width, ceilPx(ZOOM_LAYOUT_FLOOR.width * level)),
    height: Math.max(
      WINDOW_MIN.height,
      ceilPx(ZOOM_LAYOUT_FLOOR.height * level),
    ),
  };
}

/** "125%". */
export function formatZoom(level: number): string {
  return `${Math.round(level * 100)}%`;
}
