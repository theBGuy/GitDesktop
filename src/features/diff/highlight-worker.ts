/**
 * The diff syntax-highlighting Web Worker — Shiki (TextMate) only.
 *
 * Some languages the repo routes to Shiki for correctness (Rust, TSX, Astro,
 * Svelte, custom-grammar languages &c.) are too big to tokenize synchronously on
 * first paint: a 1MB tsx file would block the UI for ~3s (measured ≈3.2ms/KB).
 * Over the per-engine char budget (see DiffSurface.tsx) the sync path skips
 * Shiki, so those files fall back to the view's own highlight.js pass (or plain
 * past the renderer's line cap) — the WRONG engine for languages routed off
 * highlight.js on purpose. This worker fixes exactly that: it tokenizes the file
 * off-thread and ships back the per-side HAST ASTs, which the main thread feeds
 * into a REAL local `initSyntax` so the resulting instance is indistinguishable
 * from a locally-highlighted one (its `syntaxFile` is populated, so the view's
 * clone restores rather than wipes the highlighting on mount).
 *
 * Why ASTs, not a `getBundle()` transfer: a merged (`createInstance(data,
 * bundle)`) Shiki instance has no `oldFileResult`/`newFileResult.syntaxFile`, so
 * the view clone's no-arg `initSyntax()` re-reads empty syntax lines and wipes
 * the highlighting to plain (verified against core index.mjs:2392-2400 +
 * react:1631-1636). The bundle is also far heavier (a 12K-line file: ~45MB vs
 * ~17MB of ASTs) and its weight killed the WebView2 renderer live.
 *
 * Everything here is FAIL-OPEN: any failure (grammar load, tokenize throw)
 * responds `result: null`, and the main thread keeps its interim paint. The
 * whole handler is wrapped so no error escapes unhandled.
 *
 * This module imports ONLY from `@git-diff-view/core` (`DiffFile`), the
 * worker-safe shiki helpers, and the shared djb2/types module — never
 * `@git-diff-view/react` (React in the worker chunk) and no longer
 * `@git-diff-view/lowlight` (hljs isn't run here).
 */
import { DiffFile } from "@git-diff-view/core";
import type { CustomLanguage } from "@/lib/settings/api";
import type {
  HighlightAst,
  HighlightWorkRequest,
  HighlightWorkResponse,
  WorkerAsts,
} from "./highlight-worker-shared";
import { djb2 } from "./highlight-worker-shared";
import {
  ensureBuiltinShikiLang,
  ensureShikiGrammars,
  shikiDiffHighlighter,
} from "./shiki-highlighter";

/**
 * Load the Shiki grammar this file needs into the worker's own engine. The
 * worker starts with no grammars loaded, so it always loads on demand. Resolves
 * true when highlighting can proceed, false to fall back (interim paint).
 */
async function ensureGrammar(req: HighlightWorkRequest): Promise<boolean> {
  if (req.tmGrammar) {
    // Synthesize a CustomLanguage-shaped object carrying just the grammar;
    // ensureShikiGrammars registers it under `lang` and ignores the rest.
    const synthetic: CustomLanguage = {
      id: req.lang,
      name: req.lang,
      keywords: "",
      lineComment: "",
      blockCommentStart: "",
      blockCommentEnd: "",
      stringDelimiters: "",
      caseInsensitive: false,
      tmGrammar: req.tmGrammar as Record<string, unknown>,
    };
    ensureShikiGrammars([synthetic]);
    return true;
  }
  // A built-in Shiki language (astro/tsx/rust &c.): the dynamic `@shikijs/langs/*`
  // imports work in a Vite module worker.
  return ensureBuiltinShikiLang(req.lang);
}

async function handle(req: HighlightWorkRequest): Promise<WorkerAsts | null> {
  const ready = await ensureGrammar(req);
  if (!ready) return null;

  const file = DiffFile.createInstance({
    oldFile: {
      fileName: req.filePath,
      fileLang: req.lang,
      content: req.content?.old ?? null,
    },
    newFile: {
      fileName: req.filePath,
      fileLang: req.lang,
      content: req.content?.new ?? null,
    },
    hunks: [req.hunkText],
  });
  file.initRaw();

  // Wrap the real Shiki highlighter so we CAPTURE each side's AST as initSyntax
  // drives getAST (once per side — old then new), instead of shipping the whole
  // built DiffFile. initSyntax alone calls getAST for both sides via each
  // File.doSyntax (core composeSyntax) — no build*/getBundle needed.
  // The worker inherits the highlighter's own 15_000 reconstructed-line cap
  // (`shikiDiffHighlighter` sets it), mirroring the renderer; lifting that
  // ceiling belongs to the diff-virtualization epic.
  const inner = shikiDiffHighlighter();
  const sides: HighlightAst[] = [];
  const seen = new Set<number>();
  const capturing = {
    ...inner,
    getAST: (raw: string, fileName?: string, lang?: string) => {
      const ast = inner.getAST(raw, fileName, lang);
      const rawHash = djb2(raw);
      // Dedupe by hash: an unchanged side (identical old/new content) tokenizes
      // to the same AST, so store it once.
      if (!seen.has(rawHash)) {
        seen.add(rawHash);
        sides.push({ rawHash, ast });
      }
      return ast;
    },
  };
  file.initSyntax({ registerHighlighter: capturing });

  return { sides };
}

// Only wire the message handler inside a real Worker context (no `document`).
// Nothing on the main thread imports this entry anymore (shared helpers live in
// highlight-worker-shared.ts) — the guard is defence-in-depth so an accidental
// future re-import can't install an onmessage handler on the app window.
if (typeof document === "undefined") {
  self.onmessage = (e: MessageEvent<HighlightWorkRequest>) => {
    const req = e.data;
    handle(req)
      .then((result) => {
        const res: HighlightWorkResponse = { id: req.id, result };
        self.postMessage(res);
      })
      .catch(() => {
        // Fail-open: any throw (grammar load, tokenize, clone) → keep interim paint.
        const res: HighlightWorkResponse = { id: req.id, result: null };
        self.postMessage(res);
      });
  };
}
