import type { DiffAST } from "@git-diff-view/core";
import {
  DiffFile,
  DiffModeEnum,
  DiffView,
  DiffViewWithMultiSelect,
  type DiffViewWithMultiSelectRef,
  highlighter,
  type LineRange,
  type MultiSelectResult,
  type MultiSelectState,
  processAST,
  SplitSide,
} from "@git-diff-view/react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { useFileAtRev } from "@/lib/git/queries";
import type { FileDiff } from "@/lib/git/types";
import type { CustomLanguage } from "@/lib/settings/api";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { useEffectiveSyntax } from "@/lib/syntax/queries";
import { useIsDark } from "@/lib/use-is-dark";
import {
  capDiffText,
  DIFF_LINE_CAP,
  DIFF_MAX_LINE_CHARS,
  DIFF_MEGA_LINE_CHARS,
  longestLineLength,
  shortenLongLines,
} from "./cap-diff";
import { DiffErrorBoundary } from "./DiffErrorBoundary";
import { DiffLanguagePicker } from "./DiffLanguagePicker";
import { DiffPlaceholder } from "./DiffPlaceholder";
import { diffLang } from "./diff-lang";
import { djb2 } from "./highlight-worker-shared";
import { ImageDiff, ImagePanes, type ImageRevs, imageMime } from "./ImageDiff";
import {
  ensureBuiltinShikiLang,
  ensureShikiGrammars,
  isBuiltinShikiLang,
  isShikiLang,
  SYNTAX_LINE_CAP,
  shikiDiffHighlighter,
} from "./shiki-highlighter";
import { ensureCustomLanguages } from "./syntax";
import { useWorkerHighlight, type WorkerAsts } from "./use-worker-highlight";

/**
 * A line-anchored annotation rendered under a diff line (e.g. a PR review
 * thread), always-visible in both Unified and Split modes.
 *
 * `extendData` holds ONE entry per line per side — duplicates silently
 * last-write-win — so callers must pre-group same-side+line anchors into a
 * single stacking `render()` (as PrFilesPane does). Anchors past the
 * large-diff cap don't render until "Show full diff".
 */
export interface DiffLineAnchor {
  side: "old" | "new";
  /** 1-based line number in that side's file. */
  line: number;
  render: () => ReactNode;
}

/**
 * An inline composer opened from a diff line: click a line number (or drag a
 * range on the gutter) to open a slot BELOW that line. Generic so any surface
 * (PR review, commit comments) can reuse it. Absent = the plain vendored
 * `<DiffView>`, no clickable line numbers and no range-select wrapper — this
 * component also backs history/working-tree diffs.
 *
 * `render` receives the anchored `line` (a range's END), `fromLine` (its start,
 * equal to `line` for a single line), the resolved `side`, and an `onClose`.
 */
export interface LineWidget {
  enabled: boolean;
  render: (args: {
    side: "new" | "old";
    line: number;
    fromLine?: number;
    onClose: () => void;
  }) => ReactNode;
}

/** A normalized diff-line range on one side (`from <= to`), used by the
 *  drag-range survival tracking in {@link DiffContent}. */
type SideRange = { side: "old" | "new"; from: number; to: number };

/** The library's SplitSide enum (old=1, new=2) → our "old"/"new" tags, so the
 *  widget callback speaks the same side vocabulary as the anchors and drafts. */
const sideTag = (side: SplitSide): "new" | "old" =>
  side === SplitSide.old ? "old" : "new";

/** User syntax preferences threaded into diff building. */
export interface SyntaxPrefs {
  syntaxMap?: Record<string, string>;
  customLanguages?: CustomLanguage[];
}

/**
 * Which revisions to read each side's full file text from, so highlighting has
 * whole-file comment/string context (a hunk starting mid-block-comment would
 * otherwise mis-color everything after it). `null` = working tree; omit a side
 * when it has no version there (e.g. an added file's old side). The pair MUST
 * match the diff command's own old/new, or tokens map onto the wrong lines.
 */
export interface DiffContentRevs {
  oldRev?: string | null;
  newRev?: string | null;
}

/** Lines in a string, allocation-free (mirrors cap-diff's counter). */
function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * The highest old/new line numbers a unified diff's hunk headers reference.
 * Content mode maps syntax onto the diff BY LINE NUMBER, so a stale, shorter
 * cached read (e.g. `:0` cached when the staged file was smaller, then it grew)
 * highlights only the lines it covers and leaves the rest plain —
 * {@link useFileContent} uses this to fall back to the hunk-only path.
 */
function diffMaxLineNumbers(diffText: string): { old: number; new: number } {
  let maxOld = 0;
  let maxNew = 0;
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null = re.exec(diffText);
  while (m !== null) {
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount > 0) maxOld = Math.max(maxOld, oldStart + oldCount - 1);
    if (newCount > 0) maxNew = Math.max(maxNew, newStart + newCount - 1);
    m = re.exec(diffText);
  }
  return { old: maxOld, new: maxNew };
}

/** Decode base64 file bytes (from git_file_base64) to a UTF-8 string. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The persisted Unified/Split preference toggle. */
export function DiffModeToggle() {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const viewMode = settings.data?.diffViewMode ?? "unified";
  return (
    <ButtonGroup>
      <Button
        variant={viewMode === "unified" ? "secondary" : "ghost"}
        size="xs"
        onClick={() =>
          settings.data &&
          saveSettings.mutate({ ...settings.data, diffViewMode: "unified" })
        }
      >
        Unified
      </Button>
      <Button
        variant={viewMode === "split" ? "secondary" : "ghost"}
        size="xs"
        onClick={() =>
          settings.data &&
          saveSettings.mutate({ ...settings.data, diffViewMode: "split" })
        }
      >
        Split
      </Button>
    </ButtonGroup>
  );
}

/**
 * One rendered diff (a whole file or a single hunk) using the user's view
 * mode, theme, and syntax highlighting. Wrapped in a boundary because the
 * underlying renderer can throw while laying out certain diffs; the fallback
 * clears when `filePath`/`text` changes.
 */
export function GitDiffView({
  filePath,
  text,
  repoPath,
  contentRevs,
  lineAnchors,
  lineWidget,
}: {
  filePath: string;
  text: string;
  /** The diff's own repo, for reading full file text (highlight context). */
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  /** Line-anchored annotations (e.g. PR review threads) rendered under a line. */
  lineAnchors?: DiffLineAnchor[];
  /** Inline composer opened from a diff line. Absent = plain read-only diff. */
  lineWidget?: LineWidget;
}) {
  return (
    <DiffErrorBoundary resetKey={`${filePath} ${text.length}`}>
      <RenderedDiff
        filePath={filePath}
        text={text}
        repoPath={repoPath}
        contentRevs={contentRevs}
        lineAnchors={lineAnchors}
        lineWidget={lineWidget}
      />
    </DiffErrorBoundary>
  );
}

// Char budgets bounding the ONE-TIME synchronous tokenization on first paint.
// Measured warm cost on unique real content: highlight.js ≈0.37ms/KB (~150ms at
// the 400KB budget), Shiki ≈1ms/KB rust to ≈3.2ms/KB tsx (~150–480ms at the
// 150KB budget) — ~8× hljs, hence the tighter budget. Over budget, a Shiki
// language tokenizes off-thread ({@link useWorkerHighlight}); an hljs one keeps
// the view's own pass (≤15K lines).
const HIGHLIGHT_MAX_CHARS_HLJS = 400_000;
const HIGHLIGHT_MAX_CHARS_SHIKI = 150_000;

/**
 * Whether a diff of `textLength` chars is over the synchronous-tokenize budget
 * for the engine it routes to. Over budget for a Shiki language the sync path
 * skips highlighting and the worker tokenizes off-thread. Shared so the worker
 * call site computes engagement the SAME way {@link createDiffFile} does.
 */
export function overHighlightBudget(
  textLength: number,
  useShiki: boolean,
): boolean {
  const maxChars = useShiki
    ? HIGHLIGHT_MAX_CHARS_SHIKI
    : HIGHLIGHT_MAX_CHARS_HLJS;
  return textLength > maxChars;
}

// An empty tree for a side whose AST the worker didn't supply; the renderer
// treats it as "no highlighting" (that side plain — fail-open).
const EMPTY_WORKER_AST: DiffAST = { type: "root", children: [] };

/**
 * A @git-diff-view highlighter backed by ASTs the worker already tokenized:
 * `getAST` looks the side up by the raw text's djb2 hash — no engine on the
 * main thread; a miss returns the empty AST (that side plain). Must be fed to a
 * REAL local `initSyntax` so `syntaxFile` populates — otherwise the view's
 * clone WIPES the highlighting on mount. `type: "style"` matches Shiki's spans.
 */
function precomputedHighlighter(asts: WorkerAsts) {
  return {
    name: "shiki",
    type: "style" as const,
    maxLineToIgnoreSyntax: SYNTAX_LINE_CAP,
    setMaxLineToIgnoreSyntax: () => undefined,
    ignoreSyntaxHighlightList: [],
    setIgnoreSyntaxHighlightList: () => undefined,
    getAST: (raw: string) =>
      asts.sides.find((s) => s.rawHash === djb2(raw))?.ast ?? EMPTY_WORKER_AST,
    processAST,
    hasRegisteredCurrentLang: () => true,
  };
}
// Content mode reads and highlights BOTH whole files over IPC (≈2× the hunk
// path's cost), so it keeps the original, tighter 100KB budget.
const CONTENT_HIGHLIGHT_MAX_CHARS = 100_000;
// Content-mode line gate: past this a file isn't read in full (hunk-only path).
// Deliberately tighter than the 15_000 renderer cap — same 2× reason as above.
export const HIGHLIGHT_MAX_LINES = 2000;

// Pin the highlight.js renderer's line cap: the core gates on the RECONSTRUCTED
// file's line count, so this decides whether a small edit DEEP in a big file is
// highlighted at all — the library's default 2000 silently drops it. Placeholder
// lines tokenize at ~5–20µs (≤~200ms one-time here); real-content cost is bounded
// by the char budgets above. SYNTAX_LINE_CAP is shared with the Shiki +
// precomputed highlighters.
highlighter.setMaxLineToIgnoreSyntax(SYNTAX_LINE_CAP);

/**
 * Build a parsed `DiffFile` from unified-diff text, with syntax highlighting
 * when the file is small enough for the renderer to bother. Returns null for
 * empty/unparseable input. Exposed so callers that need the instance (e.g. the
 * line-selection manager) can build it directly.
 */
export function createDiffFile(
  filePath: string,
  text: string,
  prefs?: SyntaxPrefs,
  // Full old/new file text. When supplied, the renderer highlights the whole
  // files (correct comment/string state) and maps tokens onto the diff lines —
  // and switches to collapsible full-file context instead of a bare hunk.
  content?: { old: string | null; new: string | null },
  // Per-side ASTs the highlight worker already tokenized. Passed only for an
  // over-budget Shiki-routed file (the sync path SKIPPED Shiki): run a REAL
  // local initSyntax off them to paint the worker's highlighting in.
  workerAsts?: WorkerAsts,
): DiffFile | null {
  if (!text.trim()) return null;
  try {
    // Register any custom grammars referenced by the user's map before we look
    // up the language (idempotent; cheap when unchanged).
    const customLanguages = prefs?.customLanguages;
    if (customLanguages?.length) {
      ensureCustomLanguages(customLanguages);
    }
    const lang = diffLang(filePath, prefs?.syntaxMap);
    // Render via Shiki (VSCode-fidelity, TextMate) when the language carries a
    // full grammar — either a custom language that imported a `.tmLanguage.json`
    // or a built-in Shiki language like astro that highlight.js can't express.
    // Everything else uses highlight.js.
    const tmLang =
      lang && customLanguages?.find((c) => c.id === lang && c.tmGrammar);
    if (tmLang) ensureShikiGrammars([tmLang]);
    // Built-in Shiki grammars load lazily (useShikiRouting kicks that off), so
    // this synchronous build can only route to Shiki once the grammar is already
    // loaded. Until then a built-in Shiki language falls back to highlight.js /
    // plain; useShikiRouting's grammarState triggers the rebuild that picks it up.
    const useShiki = lang ? isShikiLang(lang) : false;
    const data = {
      oldFile: {
        fileName: filePath,
        fileLang: lang,
        content: content?.old ?? null,
      },
      newFile: {
        fileName: filePath,
        fileLang: lang,
        content: content?.new ?? null,
      },
      hunks: [text],
    };
    // Precomputed worker ASTs: a REAL local initSyntax off them yields a
    // genuinely-highlighted instance (syntaxFile populated) the view's clone
    // restores instead of wiping — as it would a getBundle-merged Shiki instance.
    if (workerAsts) {
      const file = DiffFile.createInstance(data);
      file.initRaw();
      file.initSyntax({
        registerHighlighter: precomputedHighlighter(workerAsts),
      });
      return file;
    }
    const file = DiffFile.createInstance(data);
    file.initRaw();
    // Gate on the char budget for the engine this diff routes to (~8× apart —
    // see the constants). Don't gate on line count here: that's the renderer's
    // own per-engine `maxLineToIgnoreSyntax`, and a line gate would wrongly skip
    // large Shiki files (e.g. Rust) the renderer would happily highlight.
    if (lang && !overHighlightBudget(text.length, useShiki)) {
      if (useShiki) {
        file.initSyntax({ registerHighlighter: shikiDiffHighlighter() });
      } else {
        file.initSyntax();
      }
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Reads the full old/new file text for whole-file highlight context (content
 * mode). `content` is `{old,new}` for {@link createDiffFile}, or null when
 * content mode shouldn't apply (no revs, unreadable side, or a diff too big in
 * lines/chars). `pending` is true only while content mode WANTS to apply but
 * its reads haven't settled — callers gate on it so the diff is painted ONCE in
 * its final layout instead of hunk-only then rebuilt. The rev pair MUST match
 * the diff's own old/new. `diffText`/`filePath` should already be deferred.
 */
export function useFileContent(
  repoPath: string | undefined,
  filePath: string,
  diffText: string,
  contentRevs?: DiffContentRevs,
  // Max diff size before content mode engages. The read-only surface caps its
  // render at DIFF_LINE_CAP; the staging view renders every hunk regardless, so
  // it passes the larger highlight budget instead of falling back to hunk-only.
  maxDiffLines: number = DIFF_LINE_CAP,
): { content: { old: string; new: string } | null; pending: boolean } {
  const oldRev = contentRevs?.oldRev;
  const newRev = contentRevs?.newRev;
  const wantContent =
    !!repoPath && !!contentRevs && countLines(diffText) <= maxDiffLines;
  const oldQ = useFileAtRev(
    repoPath ?? "",
    oldRev ?? null,
    filePath,
    wantContent && oldRev !== undefined,
  );
  const newQ = useFileAtRev(
    repoPath ?? "",
    newRev ?? null,
    filePath,
    wantContent && newRev !== undefined,
  );
  // An omitted side (undefined rev) has no version there → "" — gated on the
  // rev, not just the data, because a disabled `null` read shares the worktree
  // query key and would otherwise cache-hit the *other* side's content. A null
  // read with a defined rev = the file is absent there (added/deleted) → "".
  const oldText = useMemo(
    () =>
      oldRev !== undefined && oldQ.data ? decodeBase64Utf8(oldQ.data) : "",
    [oldRev, oldQ.data],
  );
  const newText = useMemo(
    () =>
      newRev !== undefined && newQ.data ? decodeBase64Utf8(newQ.data) : "",
    [newRev, newQ.data],
  );
  // Usable once the enabled side-reads settle and both files fit the highlight
  // budget (a 1-line change in a huge file stays hunk-only, no whole-file walk).
  const oldSettled = oldRev === undefined || !oldQ.isPending;
  const newSettled = newRev === undefined || !newQ.isPending;
  const fitsBudget = (s: string) =>
    s.length <= CONTENT_HIGHLIGHT_MAX_CHARS &&
    countLines(s) <= HIGHLIGHT_MAX_LINES;
  // Each side's read-back text must reach the highest line the diff references
  // (see diffMaxLineNumbers) — a stale, shorter read would half-highlight.
  const { old: maxOldLine, new: maxNewLine } = diffMaxLineNumbers(diffText);
  const covers = (s: string, max: number) => max === 0 || countLines(s) >= max;
  const useContent =
    wantContent &&
    oldSettled &&
    newSettled &&
    (oldText !== "" || newText !== "") &&
    fitsBudget(oldText) &&
    fitsBudget(newText) &&
    covers(newText, maxNewLine) &&
    covers(oldText, maxOldLine);
  // Content mode wants to apply but its reads are in flight — the caller holds
  // the paint rather than build a hunk-only diff it will restructure. isPending,
  // NOT isFetching: a background refetch of cached data must never re-blank.
  const pending = wantContent && (!oldSettled || !newSettled);
  return useMemo(
    () => ({
      content: useContent ? { old: oldText, new: newText } : null,
      pending,
    }),
    [useContent, oldText, newText, pending],
  );
}

/**
 * Shiki routing for one diff: lazily loading the built-in grammar it needs,
 * holding the paint until that settles, triggering the rebuild that picks it up,
 * and off-thread worker ASTs for an over-budget Shiki-routed diff. Shared by
 * both {@link createDiffFile} call sites so they apply the same routing rules.
 *
 * Contract: callers must list BOTH returned `grammarState` and `workerAsts` in
 * their {@link createDiffFile} memo's deps — createDiffFile reads the loaded
 * grammar via module state (isShikiLang), not a passed value, so only their
 * identity change forces the rebuild that picks it up.
 */
export function useShikiRouting({
  filePath,
  text,
  content,
  contentPending,
  blocked = false,
  syntaxMap,
  customLanguages,
}: {
  /** Deferred path of the file whose diff is being built. */
  filePath: string;
  /** The exact text that will be handed to createDiffFile (already capped/shortened). */
  text: string;
  /** Whole-file old/new content (content mode), or null. */
  content: { old: string; new: string } | null;
  /** Content-mode reads still settling — worker requests must wait on this. */
  contentPending: boolean;
  /** Surface is showing a placeholder, not a diff (mega-line block). */
  blocked?: boolean;
  syntaxMap?: Record<string, string>;
  customLanguages?: CustomLanguage[];
}): {
  holdForGrammar: boolean;
  grammarState: Record<string, "ready" | "failed">;
  workerAsts: WorkerAsts | null;
} {
  const isDark = useIsDark();

  // Built-in Shiki grammars load lazily (off the startup bundle). Hold the paint
  // until the load settles rather than rebuild on arrival (highlight pop-in).
  // Track "ready" OR "failed" so a failed import still releases the gate — a
  // missing grammar must fall back to hljs/plain, never deadlock the pane.
  const [grammarState, setGrammarState] = useState<
    Record<string, "ready" | "failed">
  >({});
  const lang = useMemo(
    () => diffLang(filePath, syntaxMap),
    [filePath, syntaxMap],
  );
  useEffect(() => {
    if (
      !lang ||
      // A blocked mega file shows a placeholder, not a diff — don't fetch a
      // grammar it will never render.
      blocked ||
      !isBuiltinShikiLang(lang) ||
      isShikiLang(lang) ||
      grammarState[lang] !== undefined ||
      // Over the Shiki budget (a builtin-Shiki lang is Shiki-routed, so that's
      // the budget that applies) the main thread never tokenizes this file —
      // the worker loads its own grammar copy. Loading here too would waste the
      // fetch AND flip grammarState, rebuilding the interim hljs paint to plain.
      overHighlightBudget(text.length, true)
    )
      return;
    let cancelled = false;
    ensureBuiltinShikiLang(lang).then((ok) => {
      if (!cancelled)
        setGrammarState((s) => ({ ...s, [lang]: ok ? "ready" : "failed" }));
    });
    return () => {
      cancelled = true;
    };
  }, [lang, grammarState, text.length, blocked]);

  // A built-in Shiki grammar this diff needs is still loading (never seen a
  // "ready"/"failed" result for it): hold the paint. `isShikiLang(lang)` already
  // true means it loaded (this or an earlier diff), so it isn't pending.
  const grammarPending =
    !!lang &&
    isBuiltinShikiLang(lang) &&
    !isShikiLang(lang) &&
    !grammarState[lang];

  // Off-thread highlighting, Shiki-only: an over-budget Shiki-routed file would
  // otherwise get the view clone's hljs pass — the engine those languages are
  // routed OFF on purpose. An over-budget hljs file sends NO request (the clone
  // already highlights it correctly, ≤15K lines). A builtin Shiki lang whose
  // grammar the main thread hasn't loaded also routes here — the worker loads
  // its own copy. A custom `tmGrammar` routes directly: its registration happens
  // lazily inside createDiffFile with no rebuild trigger, and the grammar (unlike
  // module state) is available on the first render.
  const tmGrammar = useMemo(
    () =>
      lang
        ? (customLanguages?.find((c) => c.id === lang)?.tmGrammar ?? null)
        : null,
    [lang, customLanguages],
  );
  const useShikiWorker =
    !!lang &&
    (isShikiLang(lang) || isBuiltinShikiLang(lang) || tmGrammar != null);
  const overBudget = !!lang && overHighlightBudget(text.length, useShikiWorker);
  const workerAsts = useWorkerHighlight({
    // Shiki-routed + over budget only. Don't request while whole-file reads are
    // still settling — the worker input would be built on interim text and
    // superseded. (Over budget we never hold the paint on grammarPending, so it
    // isn't gated on here.)
    enabled: overBudget && useShikiWorker && !contentPending,
    filePath,
    text,
    lang: lang ?? null,
    isDark,
    content,
    tmGrammar,
  });

  // Over budget the main thread never Shiki-tokenizes, so holding the paint for
  // a grammar only the worker needs would just delay the interim paint. Under
  // budget, hold — so the lazy-grammar rebuild still lands in one paint.
  const holdForGrammar = grammarPending && !overBudget;

  return { holdForGrammar, grammarState, workerAsts };
}

/** The per-side line -> render() maps the vendored DiffView consumes. */
type AnchorExtendData = Record<string, { data: { render: () => ReactNode } }>;

function RenderedDiff({
  filePath,
  text,
  repoPath,
  contentRevs,
  lineAnchors,
  lineWidget,
}: {
  filePath: string;
  text: string;
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  lineAnchors?: DiffLineAnchor[];
  lineWidget?: LineWidget;
}) {
  const settings = useSettings();
  const isDark = useIsDark();
  const viewMode = settings.data?.diffViewMode ?? "unified";

  // Large diffs are capped (the renderer isn't virtualized — see cap-diff.ts);
  // "Show full diff" opts into the whole thing. Reset when the file changes so
  // a previously-expanded file doesn't carry over to the next one.
  const [showFull, setShowFull] = useState(false);
  // A generated/minified file (one enormous line) shows a placeholder rather
  // than freezing the un-virtualized renderer; "Show diff anyway" opts in.
  // (Reset lives below, keyed on the DEFERRED path — see the comment there.)
  const [showAnyway, setShowAnyway] = useState(false);
  const [prevPath, setPrevPath] = useState(filePath);
  if (prevPath !== filePath) {
    setPrevPath(filePath);
    if (showFull) setShowFull(false);
  }

  // Build the diff off deferred values so rapid arrow-key navigation isn't
  // forced to rebuild on every keystroke: React keeps the previous diff on
  // screen and builds the new one at low priority, coalescing fast steps.
  const deferredText = useDeferredValue(text);
  const deferredPath = useDeferredValue(filePath);

  // Reset on the DEFERRED path, not the urgent `filePath`: `blocked` derives
  // from `deferredText`, so an urgent reset would re-block the OUTGOING mega
  // file for the transition frames and flash the placeholder over its opted-in
  // render. Keyed on deferredPath it rides the same values `blocked` reads.
  const [prevDeferredPath, setPrevDeferredPath] = useState(deferredPath);
  if (prevDeferredPath !== deferredPath) {
    setPrevDeferredPath(deferredPath);
    if (showAnyway) setShowAnyway(false);
  }

  // The longest single line drives both guards below. The renderer mounts the
  // longest line synchronously on the main thread, so a mega-line (minified
  // bundle, source map, `.tsbuildinfo`) freezes the app — that file gets a
  // placeholder; any rendered diff also hard-shortens over-long lines.
  const longestLine = useMemo(
    () => longestLineLength(deferredText),
    [deferredText],
  );
  const isMegaLine = longestLine > DIFF_MEGA_LINE_CHARS;
  const blocked = isMegaLine && !showAnyway;

  // Whole-file highlight context + collapsible expand for small diffs (`content`
  // null = capped hunk-only). Hold the whole paint while `contentPending` so the
  // diff is built ONCE in its final layout rather than rebuilt (the "flash").
  const { content, pending: contentPending } = useFileContent(
    repoPath,
    deferredPath,
    deferredText,
    // Shortened hunk text (long lines cut) would no longer line up with the
    // whole-file reads content mode maps syntax onto, and the two whole-file
    // IPC reads are pure waste when we're going to hunk-only anyway — skip
    // content mode entirely once any line is over the shorten cap.
    longestLine > DIFF_MAX_LINE_CHARS ? undefined : contentRevs,
  );

  const { shown, hidden, shortened } = useMemo(() => {
    // On a blocked mega file we show a placeholder, not a diff — do no cap or
    // shorten work on the (potentially ~1MB single-line) text.
    if (blocked) return { shown: "", hidden: 0, shortened: 0 };
    // Content mode renders the full diff (the renderer collapses non-hunk
    // context into expandable gaps), so the cap doesn't apply there.
    const capped = content
      ? { text: deferredText, hidden: 0 }
      : showFull
        ? { text: deferredText, hidden: 0 }
        : capDiffText(deferredText, DIFF_LINE_CAP);
    // Hard-shorten over-long lines UNCONDITIONALLY on whatever renders: "Show
    // full diff" reveals hidden lines but long lines stay shortened (safety
    // invariant — no rendered diff may freeze). `longestLine` is measured on the
    // FULL text, so ≤ cap there implies ≤ cap on any subset — skipping the
    // shorten pass is safe and avoids a re-scan.
    const short =
      longestLine <= DIFF_MAX_LINE_CHARS
        ? { text: capped.text, shortened: 0 }
        : shortenLongLines(capped.text, DIFF_MAX_LINE_CHARS);
    return {
      shown: short.text,
      hidden: capped.hidden,
      shortened: short.shortened,
    };
  }, [deferredText, showFull, content, blocked, longestLine]);

  // Syntax prefs follow the active repo (repo-scoped custom languages); the
  // active repo owns every surface that supplies content, so this matches.
  const activeRepo = useUiStore((s) => s.repoPath);
  const { syntaxMap, customLanguages } = useEffectiveSyntax(activeRepo);

  const { holdForGrammar, grammarState, workerAsts } = useShikiRouting({
    filePath: deferredPath,
    text: shown,
    content: content ?? null,
    contentPending,
    blocked,
    syntaxMap,
    customLanguages,
  });

  // grammarState + workerAsts: rebuild-trigger deps — see useShikiRouting's contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: grammarState is an intentional rebuild trigger, read via module state not directly
  const diffFile = useMemo(
    () =>
      blocked || contentPending || holdForGrammar
        ? null
        : createDiffFile(
            deferredPath,
            shown,
            { syntaxMap, customLanguages },
            content ?? undefined,
            workerAsts ?? undefined,
          ),
    [
      shown,
      deferredPath,
      syntaxMap,
      customLanguages,
      content,
      blocked,
      contentPending,
      holdForGrammar,
      grammarState,
      workerAsts,
    ],
  );

  // Per-side extendData maps, keyed by String(line). Memoized for referential
  // stability: the vendored DiffView is store-based and a fresh object each
  // render thrashes it.
  const extendData = useMemo(() => {
    if (!lineAnchors || lineAnchors.length === 0) return undefined;
    const oldFile: AnchorExtendData = {};
    const newFile: AnchorExtendData = {};
    for (const a of lineAnchors) {
      const target = a.side === "old" ? oldFile : newFile;
      target[String(a.line)] = { data: { render: a.render } };
    }
    return { oldFile, newFile };
  }, [lineAnchors]);

  // --- Drag-range survival across the "+" click (vendored-library workaround) ---
  // DiffViewWithMultiSelect honors a stored multi-select range ONLY when the
  // clicked "+" sits on the range's MAX line; any other selected line wipes it
  // and reports single-line. Its onSelectionComplete also stores the range only
  // when `lines.length > 0`, so an empty computation loses it. So we track the
  // last completed drag ourselves and re-apply it in renderWidgetLine. All of
  // this is scoped to the lineWidget branch — read-only surfaces never touch it.
  const multiSelectRef = useRef<DiffViewWithMultiSelectRef>(null);
  // The last completed (or in-flight, as a fallback) drag range. `dragRangeRef`
  // is set on onMultiSelectComplete; `changeRangeRef` mirrors the latest non-null
  // range seen while selecting, so the secondary empty-`lines` path still
  // captures it.
  const dragRangeRef = useRef<SideRange | null>(null);
  const changeRangeRef = useRef<SideRange | null>(null);
  // The range the CURRENTLY-OPEN overridden widget resolved to, tagged with the
  // exact anchor (side + reported line) the library passed renderWidgetLine.
  // Rule B reuses `range` ONLY when a later call reports that SAME anchor — the
  // same widget re-rendering — so it survives parent re-renders without
  // downgrading; a press on a different line reports a different anchor (the
  // library replaces its single widget WITHOUT calling our onClose) and falls
  // through to fresh resolution. Also gates capture: while set, a widget is open
  // so completion/change events are press-echo noise. Cleared in onClose.
  const activeOverrideRef = useRef<{
    anchorSide: "old" | "new";
    anchorLine: number;
    range: SideRange;
  } | null>(null);
  // The range the highlight is pinned to (or null), so an identical re-assert
  // no-ops instead of re-touching the DOM. setPreselectedLines mutates the DOM
  // only — no React state, so opening a widget triggers NO re-render, which is
  // what keeps the composer from flashing (a state bump would recreate
  // renderWidgetLine and thrash the memoized inner DiffView table).
  const preselectSigRef = useRef<string>("");
  // Re-apply the range highlight the library wiped on the "+" press (or clear it
  // on close). Deferred via a microtask so it never runs DURING render; guarded
  // by a signature so a stable open widget re-asserting the same range no-ops.
  const syncPreselect = useCallback((next: SideRange | null) => {
    const sig = next ? `${next.side}:${next.from}-${next.to}` : "";
    if (sig === preselectSigRef.current) return;
    preselectSigRef.current = sig;
    queueMicrotask(() => {
      const api = multiSelectRef.current;
      if (!api) return;
      if (next) {
        const lines = { old: [] as number[], new: [] as number[] };
        lines[next.side] = [next.from, next.to];
        api.setPreselectedLines(lines);
      } else {
        api.setPreselectedLines({ old: [], new: [] });
      }
    });
  }, []);

  const normRange = useCallback(
    (range: LineRange): SideRange => ({
      side: range.side,
      from: Math.min(range.startLineNumber, range.endLineNumber),
      to: Math.max(range.startLineNumber, range.endLineNumber),
    }),
    [],
  );

  const onMultiSelectComplete = useCallback(
    (result: MultiSelectResult) => {
      // Capture EVERY completed drag, even while a widget is open. Do NOT gate
      // on activeOverrideRef: the library can replace/dismiss a widget WITHOUT
      // calling our onClose, leaving the ref set forever and starving every
      // future drag. There is no press-echo to guard against — pressing "+"
      // calls clearSelection, so the mouseup sees isSelecting=false and fires
      // resetState only, never onSelectionComplete. A stale override is retired
      // in resolveWidgetRange instead.
      dragRangeRef.current = normRange(result.range);
    },
    [normRange],
  );
  const onMultiSelectChange = useCallback(
    (range: LineRange | null, state: MultiSelectState) => {
      // Deliberately do NOT clear dragRangeRef when a selection starts (and do
      // NOT add an `if (activeOverrideRef.current) return` guard — see
      // onMultiSelectComplete): pressing "+" itself starts a native single-line
      // selection on mousedown, before any React handler, so clearing here would
      // wipe the very range the press is opening. Staleness is handled by a real
      // drag's COMPLETE, by resolveWidgetRange on an out-of-range click, and by
      // onClose. The manager only ever fires this with isSelecting:true, so there
      // is no selection-ended branch to handle — just mirror the in-flight range
      // so the empty-`lines` mouseup path (which fires no onMultiSelectComplete)
      // still has a fallback.
      if (state.isSelecting && range) {
        changeRangeRef.current = normRange(range);
      }
    },
    [normRange],
  );

  // The best range we captured for a just-completed drag: the completed range
  // when we have it, else the last in-flight change-stream range (covers the
  // empty-`lines` mouseup path that never fires onMultiSelectComplete).
  const capturedDragRange = useCallback(
    () => dragRangeRef.current ?? changeRangeRef.current,
    [],
  );

  // Map a (lineNumber, side) to its counterpart-side line number using the
  // library's unified index. Guards every step (instance/indices may be
  // null/undefined) and returns null rather than throwing.
  const mapCrossSideLine = useCallback(
    (
      lineNumber: number,
      fromSide: "old" | "new",
      toSide: "old" | "new",
    ): number | null => {
      try {
        const instance = multiSelectRef.current?.getDiffFileInstance();
        if (!instance) return null;
        const splitSide = fromSide === "old" ? SplitSide.old : SplitSide.new;
        const index = instance.getUnifiedLineIndexByLineNumber(
          lineNumber,
          splitSide,
        );
        if (index == null || index < 0) return null;
        const item = instance.getUnifiedLine(index);
        const mapped =
          toSide === "old" ? item?.oldLineNumber : item?.newLineNumber;
        return typeof mapped === "number" ? mapped : null;
      } catch {
        return null;
      }
    },
    [],
  );

  // True when (reportedLine, side) falls inside `range` — directly on the same
  // side, or (unified mode) via cross-side line mapping when the "+" reports the
  // opposite side from the one the range was stored on.
  const clickInRange = useCallback(
    (reportedLine: number, side: "old" | "new", range: SideRange): boolean => {
      if (range.side === side) {
        return reportedLine >= range.from && reportedLine <= range.to;
      }
      const mapped = mapCrossSideLine(reportedLine, side, range.side);
      return mapped != null && mapped >= range.from && mapped <= range.to;
    },
    [mapCrossSideLine],
  );

  // Resolve the widget's effective (line, fromLine) given what the library
  // reported, overriding a single-line report when our captured drag range
  // contains the clicked line. Records the active-override identity (a ref) so
  // rule B recognizes the same widget re-rendering, but calls no library method.
  const resolveWidgetRange = useCallback(
    (
      reportedLine: number,
      reportedFrom: number,
      side: "old" | "new",
    ): SideRange => {
      // (B) The same open widget re-rendering (identical reported anchor) keeps
      // its range, so a parent re-render never downgrades it to single-line.
      const active = activeOverrideRef.current;
      if (
        active &&
        active.anchorSide === side &&
        active.anchorLine === reportedLine
      ) {
        return active.range;
      }
      // A genuinely new resolution (reported anchor differs from any active
      // override → the old widget is gone). Always REPLACE the ref with this
      // outcome — the new override on a range, null on a single line — so a dead
      // widget's override never lingers.
      const remember = (range: SideRange) => {
        activeOverrideRef.current =
          range.from !== range.to
            ? { anchorSide: side, anchorLine: reportedLine, range }
            : null;
        return range;
      };
      // The library already reported a range (its own fast path) — trust it.
      if (reportedFrom !== reportedLine) {
        return remember({ side, from: reportedFrom, to: reportedLine });
      }
      // Single-line report: override it if our captured drag range contains the
      // clicked line (the "+"-press-restarted case — see event-order note at the
      // mount below).
      const stored = capturedDragRange();
      if (stored && clickInRange(reportedLine, side, stored)) {
        return remember(stored);
      }
      // Click outside any captured range — drop the stale capture and honor the
      // single-line report.
      dragRangeRef.current = null;
      changeRangeRef.current = null;
      return remember({ side, from: reportedLine, to: reportedLine });
    },
    [clickInRange, capturedDragRange],
  );

  const diffViewMode =
    viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified;
  // A card renders inside the diff table; give it a neutral, non-mono container
  // so it doesn't inherit the code cell's font/background.
  const renderExtendLine = extendData
    ? ({ data }: { data: { render: () => ReactNode } }) => (
        <div className="border-y bg-background px-3 py-2 font-sans text-xs">
          {data.render()}
        </div>
      )
    : undefined;

  // Stable identity so a parent re-render (or a widget-open highlight sync)
  // never recreates this prop — the library memoizes its internal widget
  // renderer on [renderWidgetLine], so a fresh closure re-renders the whole
  // inner DiffView table right after the composer mounts → a visible flash.
  const renderWidgetLine = useCallback(
    ({
      lineNumber,
      fromLineNumber,
      side,
      onClose,
    }: {
      lineNumber: number;
      fromLineNumber: number;
      side: SplitSide;
      onClose: () => void;
    }) => {
      if (!lineWidget) return null;
      const resolved = resolveWidgetRange(
        lineNumber,
        fromLineNumber,
        sideTag(side),
      );
      const overrode = resolved.from !== resolved.to;
      // Re-apply the highlight the library wiped on the "+" press (see syncPreselect).
      syncPreselect(overrode ? resolved : null);
      return (
        // The library's widget slot gives the row no background, so the composer
        // gets its own opaque elevated card. The slot's `color: initial` reset
        // (and its extend-wrapper twin) is stripped at build time by a postcss
        // plugin (see vite.config.ts), so natural inheritance holds and no color
        // hammer is needed.
        //
        // The slot renders under the CLICKED line, not the range's end line — a
        // base-library limitation; the composer's "Lines X–Y" label carries the
        // true anchor.
        <div className="m-2 rounded-none border bg-popover p-3 font-sans text-xs text-popover-foreground shadow-md">
          {lineWidget.render({
            side: resolved.side,
            line: resolved.to,
            fromLine: overrode ? resolved.from : undefined,
            onClose: () => {
              // Clear our captured range, the active override, and the highlight
              // when the widget closes so the next press starts clean (a
              // previously-ranged line then opens single-line).
              dragRangeRef.current = null;
              changeRangeRef.current = null;
              activeOverrideRef.current = null;
              syncPreselect(null);
              onClose();
            },
          })}
        </div>
      );
    },
    [lineWidget, resolveWidgetRange, syncPreselect],
  );

  // A generated/minified file (one enormous line) would freeze the renderer:
  // placeholder + one-click opt-in. FIRST, so a blocked mega file never flashes
  // null while an irrelevant grammar loads.
  if (blocked) {
    return (
      <DiffPlaceholder
        message="Looks like a generated or minified file"
        action={
          <Button
            size="xs"
            variant="outline"
            onClick={() => setShowAnyway(true)}
          >
            Show diff anyway
          </Button>
        }
      />
    );
  }
  // Inputs still settling: render nothing rather than a hunk-only diff we'd
  // immediately rebuild (the single-paint gate). Must precede the empty-state
  // placeholder so loading never reads as "No changes to show". Over budget
  // `holdForGrammar` is never true — the interim hljs paint isn't delayed for a
  // grammar only the worker needs.
  if (contentPending || holdForGrammar) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  return (
    <>
      {lineWidget?.enabled ? (
        // Line-comment mode: the multi-select variant adds clickable line numbers
        // and drag-to-select, opening the composer below the line. Opt-in only.
        <DiffViewWithMultiSelect<{ render: () => ReactNode }>
          ref={multiSelectRef}
          diffFile={diffFile}
          diffViewMode={diffViewMode}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
          extendData={extendData}
          renderExtendLine={renderExtendLine}
          // Makes line-number cells clickable (flows through to the inner
          // DiffView), which is what opens the widget slot.
          diffViewAddWidget
          enableMultiSelect
          // Track the drag range ourselves so a "+" press on ANY line of it opens
          // a range composer. The library's own max-line fast path never fires:
          // "+" mousedown starts a native single-line selection in an ANCESTOR
          // listener (before React's synthetic handlers), wiping the stored
          // multiResult; the React onMouseDown then opens the widget and calls
          // clearSelection, so mouseup fires no onSelectionComplete. The widget
          // renders during the mousedown flush, BEFORE mouseup — so our captured
          // range still holds at render time and overrides the single-line report.
          onMultiSelectComplete={onMultiSelectComplete}
          onMultiSelectChange={onMultiSelectChange}
          renderWidgetLine={renderWidgetLine}
        />
      ) : (
        <DiffView<{ render: () => ReactNode }>
          diffFile={diffFile}
          diffViewMode={diffViewMode}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
          extendData={extendData}
          renderExtendLine={renderExtendLine}
        />
      )}
      {(hidden > 0 || shortened > 0) && (
        <div className="flex items-center justify-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {hidden > 0 && (
            <span>
              {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}{" "}
              hidden for performance
            </span>
          )}
          {shortened > 0 && (
            <span>
              {shortened.toLocaleString()} long{" "}
              {shortened === 1 ? "line" : "lines"} shortened
              {hidden > 0 ? "" : " for performance"}
            </span>
          )}
          {hidden > 0 && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setShowFull(true)}
            >
              Show full diff
            </Button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Renders a single file diff (with loading/binary/empty placeholders and the
 * unified/split toggle) for any diff query — working tree or a commit.
 */
export function DiffSurface({
  filePath,
  diff,
  repoPath,
  imageRevs,
  contentRevs,
  lineAnchors,
  lineWidget,
}: {
  filePath: string;
  diff: UseQueryResult<FileDiff>;
  repoPath?: string;
  imageRevs?: ImageRevs;
  contentRevs?: DiffContentRevs;
  lineAnchors?: DiffLineAnchor[];
  lineWidget?: LineWidget;
}) {
  return (
    <DiffContent
      filePath={filePath}
      data={diff.data}
      isPending={diff.isPending}
      isError={diff.isError}
      repoPath={repoPath}
      imageRevs={imageRevs}
      contentRevs={contentRevs}
      lineAnchors={lineAnchors}
      lineWidget={lineWidget}
    />
  );
}

/**
 * The diff renderer itself, decoupled from TanStack Query so callers with an
 * already-resolved FileDiff (e.g. a PR's split unified diff) can reuse it.
 */
export function DiffContent({
  filePath,
  data,
  isPending,
  isError,
  repoPath,
  imageRevs,
  contentRevs,
  lineAnchors,
  lineWidget,
}: {
  filePath: string;
  data: FileDiff | undefined;
  isPending: boolean;
  isError: boolean;
  /** With `imageRevs`, binary image files render as an image comparison. */
  repoPath?: string;
  imageRevs?: ImageRevs;
  /** Revs to read full file text from for highlight context (text diffs). */
  contentRevs?: DiffContentRevs;
  /** Line-anchored annotations (e.g. PR review threads). Absent = no anchors. */
  lineAnchors?: DiffLineAnchor[];
  /** Inline composer opened from a diff line (PR review). Absent = read-only. */
  lineWidget?: LineWidget;
}) {
  // Diffs load near-instantly from local git, so a skeleton only adds a flash
  // and a layout shift on the way to the real content — render nothing until
  // it's ready.
  if (isPending) return null;
  if (isError || !data) {
    return <DiffPlaceholder message="Could not load diff for this file" />;
  }
  if (data.isBinary) {
    if (repoPath && imageRevs && imageMime(filePath)) {
      return (
        <ImageDiff repoPath={repoPath} filePath={filePath} revs={imageRevs} />
      );
    }
    return <DiffPlaceholder message="Binary file — no text diff available" />;
  }
  if (!data.text.trim()) {
    return <DiffPlaceholder message="No changes to show" />;
  }

  // SVGs are text, but they're also images: show the rendered old/new
  // comparison above the code diff when revisions are available.
  const svgPreview = Boolean(
    repoPath && imageRevs && filePath.toLowerCase().endsWith(".svg"),
  );

  return (
    // ph-no-capture: blocks the whole pane (file path + diff body) from session
    // replay — this is user code/paths. See src/components/Redacted.tsx.
    <div className="ph-no-capture flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={filePath}>
            {filePath}
          </span>
          {data.isTruncated && (
            <span className="shrink-0">(truncated — diff too large)</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <DiffLanguagePicker filePath={filePath} />
          <DiffModeToggle />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {svgPreview && repoPath && imageRevs && (
          <div className="border-b">
            <ImagePanes
              repoPath={repoPath}
              filePath={filePath}
              revs={imageRevs}
            />
          </div>
        )}
        <GitDiffView
          filePath={filePath}
          text={data.text}
          repoPath={repoPath}
          // A truncated diff was cut by the byte cap and can't line up with the
          // full file text, so don't try whole-file highlighting there.
          contentRevs={data.isTruncated ? undefined : contentRevs}
          lineAnchors={lineAnchors}
          lineWidget={lineWidget}
        />
      </div>
    </div>
  );
}
