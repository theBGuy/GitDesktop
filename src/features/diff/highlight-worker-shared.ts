// Shared between the worker entry (`highlight-worker.ts`) and the main thread
// (`use-worker-highlight.ts`, `DiffSurface.tsx`), so the worker implementation
// never enters a main-thread chunk: the main thread imports `djb2` and these
// types from here, and references the worker only via `new Worker(new
// URL("./highlight-worker.ts", ...))`.
import type { DiffAST } from "@git-diff-view/core";

/** djb2 over a full string — O(n) at ~1ms/MB, negligible next to tokenize. The
 *  hook keys request signatures with it; the worker tags each captured side's
 *  raw text with it so the main-thread highlighter can look its AST up by hash.
 *  Shared from here so the two never drift. */
export function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

/** One tokenized side: the raw text's djb2 hash paired with its HAST. */
export interface HighlightAst {
  rawHash: number;
  ast: DiffAST;
}

/** The worker's payload: the per-side tokenized ASTs (old + new). */
export interface WorkerAsts {
  sides: HighlightAst[];
}

/** Work posted from the main thread. The worker is Shiki-only, so there's no
 *  engine flag — the call site only requests when the file routes to Shiki. */
export interface HighlightWorkRequest {
  id: number;
  filePath: string;
  /** Already resolved on the main thread via `diffLang`. */
  lang: string;
  hunkText: string;
  content: { old: string | null; new: string | null } | null;
  /** A custom language's raw tmLanguage JSON, when that's what routed to Shiki. */
  tmGrammar: object | null;
}

/** The worker's reply. `result: null` means "couldn't highlight — keep the
 *  interim paint". */
export interface HighlightWorkResponse {
  id: number;
  result: WorkerAsts | null;
}
