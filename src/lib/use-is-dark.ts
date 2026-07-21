import { useSyncExternalStore } from "react";

/**
 * OS color-scheme media query, shared so we don't create one per module. The
 * theme resolver (theme.ts) reads it for the `"system"` preference; the app's
 * actual light/dark state is the `.dark` class on <html>, which the resolver is
 * the sole writer of.
 */
export const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

// Stable subscribe/getSnapshot references so useSyncExternalStore subscribes once
// per mount instead of tearing down and recreating the MutationObserver on every
// render (useIsDark is read by the diff viewer and code editor).
function subscribeToThemeClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function isDarkSnapshot(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Reactive "is the app in dark mode?" for components that theme themselves in JS
 * (the diff viewer, the code editor). Tracks the resolved theme — it reads the
 * `.dark` class on <html> that theme.ts sets from the user's
 * System/Light/Dark/Slate choice — so a manual override reaches these
 * surfaces, not just the OS `prefers-color-scheme`. (Slate keeps `.dark`,
 * so it correctly reads as dark here.)
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeToThemeClass, isDarkSnapshot);
}
