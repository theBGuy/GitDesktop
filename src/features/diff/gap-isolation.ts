// Import from core, never the react entry: both re-export the same singleton,
// but this module is reachable from the highlight worker (highlight-worker ->
// shiki-highlighter -> here), where react would pull React into the chunk.
import { type DiffAST, highlighter } from "@git-diff-view/core";

/**
 * Segment-aware tokenization for hunk-reconstructed ("holey") diff buffers,
 * whose elided regions arrive as blank placeholder lines. Tokenizing each run
 * of non-blank lines on its own keeps tokenizer state from crossing a gap, so a
 * construct a hunk boundary left unclosed can't paint the rest of the buffer.
 * Trade-off: a construct spanning a GENUINE blank line inside a holey buffer
 * now resets there — a bounded local mis-color in place of unbounded bleed, on
 * a path (hunk-mode highlighting) that is already best-effort.
 */

/** Buffers below this many lines are never treated as holey. */
const HOLEY_MIN_LINES = 50;
/** Blank-line ratio at which a buffer is treated as hunk-reconstructed.
 *  Measured holey buffers run ~99% blank; no file in this repo reaches 50%
 *  (highest among the 519 code files of >=50 lines: 15%). */
const HOLEY_MIN_BLANK_RATIO = 0.5;

/**
 * Whether pre-split `lines` look hunk-reconstructed. Blank means exactly `""` —
 * placeholder lines carry no whitespace, so whitespace-only lines stay real
 * content (and a CRLF file's content lines end `"\r"`, keeping them non-blank).
 */
function isHoley(lines: readonly string[]): boolean {
  if (lines.length < HOLEY_MIN_LINES) return false;
  let blank = 0;
  for (const line of lines) if (line === "") blank++;
  return blank / lines.length >= HOLEY_MIN_BLANK_RATIO;
}

/** Flattened text length of an AST, without materializing the string. */
function astTextLength(node: DiffAST | DiffAST["children"][number]): number {
  if (node.type === "text") return node.value.length;
  return "children" in node
    ? node.children.reduce((sum, child) => sum + astTextLength(child), 0)
    : 0;
}

/** Tokenize each run of non-blank lines separately and merge the ASTs. `lines`
 *  must be `raw.split("\n")`. */
function mergeSegments(
  raw: string,
  lines: readonly string[],
  tokenize: (segment: string) => DiffAST,
): DiffAST {
  // N split elements are joined by exactly N-1 "\n" separators: one separator
  // PRECEDES every element but the first. A run of non-blank elements keeps its
  // internal separators inside the segment text handed to `tokenize`.
  const children: DiffAST["children"] = [];
  let i = 0;
  let sepsPending = 0;
  const emitSeps = () => {
    if (sepsPending > 0) {
      children.push({ type: "text", value: "\n".repeat(sepsPending) });
      sepsPending = 0;
    }
  };
  while (i < lines.length) {
    if (lines[i] === "") {
      if (i > 0) sepsPending++;
      i++;
      continue;
    }
    if (i > 0) sepsPending++;
    emitSeps();
    const start = i;
    while (i < lines.length && lines[i] !== "") i++;
    const segmentAst = tokenize(lines.slice(start, i).join("\n"));
    // Appended one at a time: a long contiguous run can exceed the engine's
    // argument limit when spread into push().
    for (const child of segmentAst.children ?? []) children.push(child);
  }
  emitSeps();
  const merged: DiffAST = { type: "root", children };
  // An engine whose AST doesn't flatten back to its input (e.g. an empty-tree
  // fallback for one segment) would drop text, so fall back to the whole-buffer
  // pass — the wrapper is then never worse than not wrapping.
  return astTextLength(merged) === raw.length ? merged : tokenize(raw);
}

/**
 * Tokenize `raw` segment by segment when it looks hunk-reconstructed; a
 * sub-threshold buffer takes the unchanged single `tokenize(raw)` path.
 */
export function gapIsolatedAst(
  raw: string,
  tokenize: (segment: string) => DiffAST,
): DiffAST {
  const lines = raw.split("\n");
  return isHoley(lines) ? mergeSegments(raw, lines, tokenize) : tokenize(raw);
}

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
      return { ...merged, data: whole.data };
    };

    engine.highlight = markInstalled(isolatedHighlight);
    engine.highlightAuto = markInstalled(isolatedAuto);
  } catch {
    // fail open: diffs render without gap isolation
  }
}
