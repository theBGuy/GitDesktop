import { useSyncExternalStore } from "react";

/**
 * OS color-scheme media query, shared so we don't create one per module. The
 * theme resolver (theme.ts) reads it for the `"system"` preference; the app's
 * actual light/dark state is the `.dark` class on <html>, which the resolver is
 * the sole writer of.
 */
export const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Reactive "is the app in dark mode?" for components that theme themselves in JS
 * (the diff viewer, the code editor). Tracks the resolved theme — it reads the
 * `.dark` class on <html> that theme.ts sets from the user's
 * System/Light/Dark/Slate choice — so a manual override reaches these
 * surfaces, not just the OS `prefers-color-scheme`. (Slate keeps `.dark`,
 * so it correctly reads as dark here.)
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains("dark"),
  );
}
