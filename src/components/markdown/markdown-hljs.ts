/**
 * Lazy upgrade from highlight.js's `lib/common` (~37 languages, statically
 * imported by markdown.tsx for instant, flicker-free highlighting of the common
 * fences) to the FULL ~192-language build — loaded on demand the first time a
 * markdown fence names a language `lib/common` doesn't know.
 *
 * Why this works with a single shared reference: both `highlight.js/lib/common`
 * and `highlight.js` (full) import the SAME `highlight.js/lib/core` singleton
 * and call `registerLanguage` on it. So `import("highlight.js")` registers every
 * language into the exact instance markdown.tsx already holds — the upgrade is
 * just awaiting that import; no re-registration or reference swap needed.
 * (Verified against the installed package: `es/common.js` and `es/index.js` both
 * re-export from `lib/*.js`, each doing `require('./core')`.)
 *
 * Reactivity: module state read during render is invisible to the React
 * Compiler's memoization, so the "full build loaded" flag is exposed through a
 * `useSyncExternalStore` snapshot (mirrors `useAvailableActions` in
 * src/lib/hotkeys/hotkeys.tsx). When the full build lands we bump the version and
 * notify; subscribed Markdown components re-render, marked re-parses, and fences
 * that rendered plain now highlight.
 */

const subscribers = new Set<() => void>();

// Bumped once when the full build finishes loading; the monotonic value is the
// useSyncExternalStore snapshot (a number is a stable, cheap identity).
let version = 0;
let fullLoaded = false;
let importStarted = false;

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function getSnapshot(): number {
  return version;
}

function notify(): void {
  version++;
  for (const fn of subscribers) fn();
}

/**
 * Kick off the one-time load of the full highlight.js build. Idempotent and
 * guarded so only ever one import is in flight; safe to call from module scope
 * (the marked code renderer's miss path). Misses before it resolves just render
 * plain and get fixed by the notify once it lands.
 */
export function upgradeToFullHljs(): void {
  if (importStarted) return;
  importStarted = true;
  // Registers all languages into the shared lib/core singleton (see file docs).
  import("highlight.js")
    .then((mod) => {
      // Consume the module's default export — do NOT simplify this to
      // `.then(() => …)`. highlight.js's `sideEffects` whitelist lists only
      // `*/common.js`, so the full build's `registerLanguage(...)` calls look
      // tree-shakeable; without a used binding the bundler drops every
      // non-common grammar (the lazy chunk builds empty and dockerfile &c. never
      // highlight). Reading the default export keeps the whole build live.
      registeredCount = mod.default.listLanguages().length;
      fullLoaded = true;
      notify();
    })
    .catch(() => {
      // Load failed — leave importStarted true so we don't spin retrying; the
      // common set still highlights and exotic fences stay plain (no throw).
    });
}

// The language count after the full build lands (≈192); read via
// hljsLanguageCount() and also anchors the dynamic import's used exports.
let registeredCount = 0;

/** How many languages are registered right now (≈37 common, ≈192 upgraded). */
export function hljsLanguageCount(): number {
  return registeredCount;
}

/** Whether the full highlight.js build has finished loading. */
export function isFullHljsLoaded(): boolean {
  return fullLoaded;
}

/** useSyncExternalStore tuple: subscribe + snapshot (a version number that
 *  changes once when the full build lands). Server snapshot is the same. */
export const hljsUpgradeStore = {
  subscribe,
  getSnapshot,
  getServerSnapshot: getSnapshot,
};
