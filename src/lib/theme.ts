import { darkQuery } from "@/lib/use-is-dark";

/**
 * The user's theme preference (Settings → Appearance). `"system"` follows the OS
 * color scheme; `"light"` / `"dark"` force it; `"slate"` is a softer dark variant
 * (a lifted, cool blue-gray canvas with off-white ink instead of near-black on
 * near-white) that reduces the halation / eye-strain of the maximum-contrast
 * default. Persisted in {@link AppSettings}; mirrored to `localStorage` so the
 * very first paint on a cold boot reflects a saved override with no flash before
 * the async settings store resolves.
 */
export type ThemeSetting = "system" | "light" | "dark" | "slate";

/** Human labels for the picker (also the source for the palette `items` map). */
export const THEME_LABELS: Record<ThemeSetting, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  slate: "Slate",
};

/** Order the "Cycle theme" command steps through. */
export const THEME_ORDER: ThemeSetting[] = ["system", "light", "dark", "slate"];

/** The theme one step after `current` in {@link THEME_ORDER} (wraps around). */
export function nextTheme(current: ThemeSetting): ThemeSetting {
  const i = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

/**
 * Chrome typeface (Settings → Appearance). Code, diffs, and the terminal keep
 * JetBrains Mono via `--font-mono`; this only drives `--gd-ui-font`.
 */
export type UiFont = "jetbrains-mono" | "inter" | "system";

export const UI_FONT_LABELS: Record<UiFont, string> = {
  "jetbrains-mono": "JetBrains Mono",
  inter: "Inter",
  system: "System UI",
};

export const UI_FONT_ORDER: UiFont[] = ["jetbrains-mono", "inter", "system"];

export const DEFAULT_ACCENT_HUE = 175;
export const DEFAULT_UI_FONT: UiFont = "jetbrains-mono";

/** Same stack as `--font-mono` in App.css. xterm can't inherit CSS font-family
 *  (it paints its own canvas), so the in-app terminal reads this string. */
export const MONO_FONT_STACK = '"JetBrains Mono Variable", monospace';

const FONT_STACKS: Record<UiFont, string> = {
  "jetbrains-mono": MONO_FONT_STACK,
  inter: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  system: "ui-sans-serif, system-ui, sans-serif",
};

const LS_THEME = "gd-theme";
const LS_HUE = "gd-accent-hue";
const LS_FONT = "gd-ui-font";

export type AppearancePrefs = {
  theme: ThemeSetting;
  accentHue: number;
  uiFont: UiFont;
};

function isTheme(value: unknown): value is ThemeSetting {
  return (
    value === "system" ||
    value === "light" ||
    value === "dark" ||
    value === "slate"
  );
}

export function isUiFont(value: unknown): value is UiFont {
  return value === "jetbrains-mono" || value === "inter" || value === "system";
}

/** Round and clamp a stored hue; garbage from an older or hand-edited store
 *  heals to the mint default instead of writing `NaN` into `oklch()`. */
export function sanitizeAccentHue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ACCENT_HUE;
  }
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 360) return DEFAULT_ACCENT_HUE;
  return rounded;
}

export function sanitizeUiFont(value: unknown): UiFont {
  return isUiFont(value) ? value : DEFAULT_UI_FONT;
}

export function isDefaultAccentAndFont(
  accentHue: number,
  uiFont: UiFont,
): boolean {
  return accentHue === DEFAULT_ACCENT_HUE && uiFont === DEFAULT_UI_FONT;
}

// Last applied preference. The OS-change listener re-reads it so a `"system"`
// user keeps tracking the OS while an explicit override stays pinned; hue and
// font overlay whichever base is active.
let active: AppearancePrefs = {
  theme: "system",
  accentHue: DEFAULT_ACCENT_HUE,
  uiFont: DEFAULT_UI_FONT,
};

function apply(): void {
  const dark =
    active.theme === "dark" ||
    active.theme === "slate" ||
    (active.theme === "system" && darkQuery.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  // `slate` only ever rides alongside `dark` (it forces dark above), so the
  // cool-ramp override in App.css (`.dark.slate`) always has its base surface.
  root.classList.toggle("slate", active.theme === "slate");
  root.style.setProperty("--accent-hue", String(active.accentHue));
  root.style.setProperty("--gd-ui-font", FONT_STACKS[active.uiFont]);
}

function writeMirror(prefs: AppearancePrefs): void {
  try {
    localStorage.setItem(LS_THEME, prefs.theme);
    localStorage.setItem(LS_HUE, String(prefs.accentHue));
    localStorage.setItem(LS_FONT, prefs.uiFont);
  } catch {
    // A locked-down webview can throw on localStorage; the class/vars are still
    // applied and the settings store stays the source of truth, so the only
    // cost is a possible flash on the next cold boot.
  }
}

/**
 * Apply appearance prefs to the document, remember them as the source of
 * truth for boot + OS-change reconciliation, and mirror them to `localStorage`
 * for a flash-free next boot. Call on save (Settings pickers, Cycle-theme)
 * and whenever the persisted value resolves from the store.
 */
export function commitAppearance(prefs: AppearancePrefs): void {
  active = {
    theme: prefs.theme,
    accentHue: sanitizeAccentHue(prefs.accentHue),
    uiFont: sanitizeUiFont(prefs.uiFont),
  };
  writeMirror(active);
  apply();
}

/**
 * Read the mirrored preference synchronously and apply it before first paint,
 * then keep `"system"` tracking the OS. Called once from `main.tsx`; the
 * authoritative value from the settings store reconciles via {@link commitAppearance}
 * once it loads.
 */
export function initTheme(): void {
  let storedTheme: string | null = null;
  let storedHue: string | null = null;
  let storedFont: string | null = null;
  try {
    storedTheme = localStorage.getItem(LS_THEME);
    storedHue = localStorage.getItem(LS_HUE);
    storedFont = localStorage.getItem(LS_FONT);
  } catch {
    // Some locked-down webviews throw on any localStorage access. initTheme runs
    // before first paint, so an unguarded throw here would crash startup; fall
    // back to defaults — the store still reconciles the real value via commitAppearance.
  }
  const hue =
    storedHue === null ? DEFAULT_ACCENT_HUE : Number.parseInt(storedHue, 10);
  active = {
    theme: isTheme(storedTheme) ? storedTheme : "system",
    accentHue: sanitizeAccentHue(hue),
    uiFont: sanitizeUiFont(storedFont),
  };
  apply();
  darkQuery.addEventListener("change", apply);
}
