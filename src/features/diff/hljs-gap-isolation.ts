// Import from core, never the react entry: both re-export the same singleton,
// but react would pull React into any chunk this module reaches.
import { highlighter } from "@git-diff-view/core";
import { gapIsolatedAst, isHoley, mergeSegments } from "./gap-isolation";

// A registry symbol, not a module-local one: on HMR this module re-evaluates
// with fresh state while the lowlight singleton keeps the installed wrapper, so
// the "already patched" mark must be readable across module instances.
const GAP_ISOLATED = Symbol.for("gd.diff.gapIsolated");

function markInstalled<T extends object>(fn: T): T {
  return Object.defineProperty(fn, GAP_ISOLATED, { value: true });
}

/**
 * Give the highlight.js singleton gap isolation. @git-diff-view's default
 * `initSyntax()` and the react view clone's re-tokenize both run through this
 * one exported instance, so it is the only seam covering both. Its `getAST` is
 * a non-writable, non-configurable property, so the wrap lands one level down
 * on the lowlight engine — covering both of getAST's tokenize exits, a
 * registered language via `highlight` and an unregistered one via
 * `highlightAuto`. Fails open: if the engine ever refuses the patch, diffs
 * render without gap isolation rather than the module throwing at import.
 * Idempotent, and must be called explicitly at module scope (a bare
 * side-effect import can be dropped).
 */
export function installHljsGapIsolation(): void {
  try {
    const engine = highlighter.getHighlighterEngine();
    if (GAP_ISOLATED in engine.highlight) return;
    const originalHighlight = engine.highlight;
    const originalAuto = engine.highlightAuto;

    const isolatedHighlight: typeof engine.highlight = (
      language,
      value,
      options,
    ) =>
      gapIsolatedAst(value, (segment) =>
        originalHighlight.call(engine, language, segment, options),
      );

    // Language detection stays whole-buffer, and every segment is tokenized as
    // that one language: detecting per segment could resolve a different
    // language for each, coloring one buffer inconsistently.
    const isolatedAuto: typeof engine.highlightAuto = (value, options) => {
      const whole = originalAuto.call(engine, value, options);
      const detected = whole.data?.language;
      if (!detected) return whole;
      const lines = value.split("\n");
      if (!isHoley(lines)) return whole;
      const merged = mergeSegments(value, lines, (segment) =>
        originalHighlight.call(engine, detected, segment, options),
      );
      return merged ? { ...merged, data: whole.data } : whole;
    };

    engine.highlight = markInstalled(isolatedHighlight);
    engine.highlightAuto = markInstalled(isolatedAuto);
  } catch {
    // fail open: diffs render without gap isolation
  }
}
