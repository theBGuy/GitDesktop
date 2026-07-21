import { darkQuery } from "@/lib/use-is-dark";

/**
 * The user's theme preference (Settings → Appearance). `"system"` follows the OS
 * color scheme; `"light"` / `"dark"` force it; `"dark-dimmed"` is a softer dark
 * variant (surfaces lifted off pure black + off-white ink instead of pure white)
 * that reduces the halation/eye-strain of the maximum-contrast default. Persisted
 * in {@link AppSettings}; mirrored to `localStorage` so the very first paint on a
 * cold boot reflects a saved override with no flash before the async settings
 * store resolves.
 */
export type ThemeSetting = "system" | "light" | "dark" | "dark-dimmed";

/** Human labels for the picker (also the source for the palette `items` map). */
export const THEME_LABELS: Record<ThemeSetting, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  "dark-dimmed": "Dark Dimmed",
};

/** Order the "Cycle theme" command steps through. */
export const THEME_ORDER: ThemeSetting[] = [
  "system",
  "light",
  "dark",
  "dark-dimmed",
];

/** The theme one step after `current` in {@link THEME_ORDER} (wraps around). */
export function nextTheme(current: ThemeSetting): ThemeSetting {
  const i = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

const LS_KEY = "gd-theme";

function isTheme(value: unknown): value is ThemeSetting {
  return (
    value === "system" ||
    value === "light" ||
    value === "dark" ||
    value === "dark-dimmed"
  );
}

// The last applied preference. The OS-change listener re-reads it so a `"system"`
// user keeps tracking the OS while an explicit override stays pinned.
let active: ThemeSetting = "system";

function apply(): void {
  const dark =
    active === "dark" ||
    active === "dark-dimmed" ||
    (active === "system" && darkQuery.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  // `dimmed` only ever rides alongside `dark` — "dark-dimmed" forces dark above,
  // so the neutral-ramp override in App.css (`.dark.dimmed`) always has its base.
  root.classList.toggle("dimmed", active === "dark-dimmed");
}

/**
 * Apply a theme preference to the document, remember it as the source of truth
 * for boot + OS-change reconciliation, and mirror it to `localStorage` for a
 * flash-free next boot. Call on save (Settings picker, Cycle-theme command) and
 * whenever the persisted value resolves from the store.
 */
export function commitTheme(theme: ThemeSetting): void {
  active = theme;
  try {
    localStorage.setItem(LS_KEY, theme);
  } catch {
    // A locked-down webview can throw on localStorage; the class is still applied
    // and the settings store stays the source of truth, so the only cost is a
    // possible flash on the next cold boot.
  }
  apply();
}

/**
 * Read the mirrored preference synchronously and apply it before first paint,
 * then keep `"system"` tracking the OS. Called once from `main.tsx`; the
 * authoritative value from the settings store reconciles via {@link commitTheme}
 * once it loads.
 */
export function initTheme(): void {
  const stored = localStorage.getItem(LS_KEY);
  active = isTheme(stored) ? stored : "system";
  apply();
  darkQuery.addEventListener("change", apply);
}
