import type { DiffAST, DiffFileHighlighter } from "@git-diff-view/core";
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
  SplitSide,
} from "@git-diff-view/react";
import { FileIcon, GearSixIcon } from "@phosphor-icons/react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { InfoNote } from "@/components/info-note";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { useCloseSettled } from "@/features/repository/publish-confirm";
import { decodeBase64Utf8 } from "@/lib/git/api";
import {
  classifyHeaderOnlyDiff,
  type HeaderOnlyDiff,
  headerOnlyMessage,
  modeChangeMessage,
  type TypechangeHalves,
  typechangeHalves,
} from "@/lib/git/diff-split";
import { useFileAtRev } from "@/lib/git/queries";
import type { FileDiff } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { CustomLanguage } from "@/lib/settings/api";
import {
  useHideWhitespace,
  useSetHideWhitespace,
} from "@/lib/settings/hide-whitespace";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { useEffectiveSyntax } from "@/lib/syntax/queries";
import { toastError } from "@/lib/toast";
import { useContainerWidth } from "@/lib/use-container-width";
import { useIsDark } from "@/lib/use-is-dark";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { BinaryFileSummary } from "./BinaryFileSummary";
import {
  capDiffText,
  DIFF_LINE_CAP,
  DIFF_MAX_LINE_CHARS,
  DIFF_MEGA_LINE_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightCostLength,
  longestLineLength,
  realLineCount,
  shortenLongLines,
} from "./cap-diff";
import { DiffErrorBoundary } from "./DiffErrorBoundary";
import { DiffLanguagePicker } from "./DiffLanguagePicker";
import { DIFF_PANE_ROOT_CLASS, DiffPathRow } from "./DiffPathRow";
import { DiffPlaceholder } from "./DiffPlaceholder";
import { diffLang, fileExt } from "./diff-lang";
import {
  useDiffPaneHold,
  useInDiffPaneSlot,
  useReportPaneSettled,
} from "./diff-pane-hold";
import { HOLD_BOUND_MS } from "./diff-pane-slots";
import "./code-highlight.css";
import {
  anchorRow,
  anchorRows,
  anchorScrollTop,
  captureLineAnchor,
  diffRendersRows,
  type LineAnchor,
  landHunkFocus,
  PANE_SCROLL_KEYS,
  RESTORE_BOUND_MS,
  restoreDecision,
} from "./diff-rows";
import {
  changesSince,
  contentBuildGate,
  contentReadsKey,
  type Painted,
  paintedAfter,
} from "./file-content-gate";
import { HUNK_SCOPED_MAX_LINES, hunkScopedProcessAST } from "./gap-isolation";
import { djb2 } from "./highlight-worker-shared";
import {
  hunkScopedHljsHighlighter,
  installHljsGapIsolation,
} from "./hljs-gap-isolation";
import { installPatchedJsGrammars } from "./hljs-ts-no-jsx";
import { ImageDiff, ImagePanes, type ImageRevs, imageMime } from "./ImageDiff";
import {
  canPreviewMarkdown,
  type MarkdownDiffView,
  MarkdownDocPreview,
  MarkdownViewToggle,
} from "./MarkdownPreview";
import {
  ensureBuiltinShikiLang,
  ensureShikiGrammars,
  isBuiltinShikiLang,
  isShikiLang,
  SYNTAX_LINE_CAP,
  shikiDiffHighlighter,
} from "./shiki-highlighter";
import { SPLIT_MIN_CONTAINER_PX } from "./split-threshold";
import { ensureCustomLanguages } from "./syntax";
import { type StagingSide, UNDECODABLE_NOTE_COPY } from "./undecodable-note";
import {
  useFocusOnControlsSwap,
  useHiddenTriggerFocus,
} from "./use-hidden-trigger-focus";
import { useWorkerHighlight, type WorkerAsts } from "./use-worker-highlight";
import {
  SHOW_WHITESPACE_LABEL,
  WHITESPACE_COMPOSER_HELD,
  WHITESPACE_ONLY_MESSAGE,
} from "./whitespace-mode";

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

/** A (lineNumber, side)'s counterpart-side line number via the library's
 *  unified index, or null on any missing step or throw. Module scope: the
 *  React Compiler can't lower value blocks inside a try/catch. */
function crossSideLine(
  viewRef: { readonly current: DiffViewWithMultiSelectRef | null },
  lineNumber: number,
  fromSide: "old" | "new",
  toSide: "old" | "new",
): number | null {
  try {
    const instance = viewRef.current?.getDiffFileInstance();
    if (!instance) return null;
    const splitSide = fromSide === "old" ? SplitSide.old : SplitSide.new;
    const index = instance.getUnifiedLineIndexByLineNumber(
      lineNumber,
      splitSide,
    );
    if (index == null || index < 0) return null;
    const item = instance.getUnifiedLine(index);
    const mapped = toSide === "old" ? item?.oldLineNumber : item?.newLineNumber;
    return typeof mapped === "number" ? mapped : null;
  } catch {
    return null;
  }
}

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

/** `\n`-split segments in a string, allocation-free. A final newline's empty
 *  segment counts too: the coverage check is unaffected (it compares against
 *  the last real line) and the read-back budget errs one line tight.
 *  Diff-size gates use cap-diff's realLineCount instead. */
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

/**
 * Whether the highlight.js singleton would skip this diff: hunk-only mode pads
 * each side to the highest line its hunks reference, and the core skips a side
 * whose padded length (that + 1, hence `>=`) passes SYNTAX_LINE_CAP. Content
 * mode never qualifies: its reads cap at HIGHLIGHT_MAX_LINES.
 */
function pastSyntaxCap(diffText: string): boolean {
  const max = diffMaxLineNumbers(diffText);
  return Math.max(max.old, max.new) >= SYNTAX_LINE_CAP;
}

/** The persisted Unified/Split preference toggle. */
export function DiffModeToggle({
  splitDisabled = false,
}: {
  /** The pane is too narrow to render split (see {@link SPLIT_MIN_CONTAINER_PX}).
   *  The active segment follows what's ON SCREEN, so Unified reads as active
   *  while the override holds — and because it does, its write is withheld too:
   *  a persisted `split` must survive the narrow pane that hid it, so neither
   *  button may touch the preference while the override stands in for it. */
  splitDisabled?: boolean;
}) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const viewMode = settings.data?.diffViewMode ?? "unified";
  const effectiveViewMode = splitDisabled ? "unified" : viewMode;
  return (
    // DisabledReasonButton's wrapper span has no `data-slot`, so it opts out of
    // ButtonGroup's border-collapse/rounding child selectors — this call site
    // owns the seam on the Button instead (same arrangement as SyncControls).
    <ButtonGroup aria-label="Diff view mode">
      <Button
        variant={effectiveViewMode === "unified" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={effectiveViewMode === "unified"}
        onClick={() => {
          if (splitDisabled || !settings.data) return;
          void saveSettings
            .mutateAsync({ ...settings.data, diffViewMode: "unified" })
            .catch(toastError);
        }}
      >
        Unified
      </Button>
      <DisabledReasonButton
        variant={effectiveViewMode === "split" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={effectiveViewMode === "split"}
        disabled={splitDisabled}
        reason="Pane too narrow for split view"
        className="border-l-0 focus-visible:relative focus-visible:z-10"
        onClick={() => {
          if (!settings.data) return;
          void saveSettings
            .mutateAsync({ ...settings.data, diffViewMode: "split" })
            .catch(toastError);
        }}
      >
        Split
      </DisabledReasonButton>
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
  oldPath,
  text,
  repoPath,
  contentRevs,
  lineAnchors,
  lineWidget,
  forceUnified,
  revealLanding,
  scrollerRef,
}: {
  filePath: string;
  /** The path the old side's whole-file read uses (a rename's source).
   *  Omitted = `filePath`, for hosts with no old side to read. */
  oldPath?: string;
  text: string;
  /** The diff's own repo, for reading full file text (highlight context). */
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  /** Line-anchored annotations (e.g. PR review threads) rendered under a line. */
  lineAnchors?: DiffLineAnchor[];
  /** Inline composer opened from a diff line. Absent = plain read-only diff. */
  lineWidget?: LineWidget;
  /** Render unified whatever the preference says — the measuring pane sets this
   *  when it's too narrow for split. Omitted = follow the preference. */
  forceUnified?: boolean;
  /** Where focus lands when Show full diff takes its own button away and the
   *  diff's own group isn't mounted to take it (the host's path-row controls).
   *  Omitted = a sink rendered beside the diff. */
  revealLanding?: { readonly current: HTMLElement | null };
  /** The host's scroller, whose top visible line a split/unified switch or a
   *  Show full diff expand keeps. Omitted = no restore. */
  scrollerRef?: { readonly current: HTMLElement | null };
}) {
  const sinkRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      {/* Outside the error boundary, so the landing survives a failed build. */}
      {revealLanding === undefined && (
        <span ref={sinkRef} tabIndex={-1} className="sr-only" />
      )}
      <DiffErrorBoundary resetKey={`${filePath} ${text.length}`}>
        <RenderedDiff
          filePath={filePath}
          oldPath={oldPath}
          text={text}
          repoPath={repoPath}
          contentRevs={contentRevs}
          lineAnchors={lineAnchors}
          lineWidget={lineWidget}
          forceUnified={forceUnified}
          revealLanding={revealLanding ?? sinkRef}
          scrollerRef={scrollerRef}
        />
      </DiffErrorBoundary>
    </>
  );
}

// Char budgets bounding the ONE-TIME synchronous tokenization on first paint.
// Measured warm cost on unique real content: highlight.js ≈0.37ms/KB (~150ms at
// the 400KB budget), Shiki ≈1ms/KB rust to ≈3.2ms/KB tsx (~150–480ms at the
// 150KB budget) — ~8× hljs, hence the tighter budget. Over budget, a Shiki
// language tokenizes off-thread ({@link useWorkerHighlight}); an hljs one keeps
// the view's own whole-buffer pass (plain past SYNTAX_LINE_CAP lines).
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

// useShikiRouting's rebuild key while a diff is worker-routed: one stable
// identity, so a grammar load then never re-triggers a build.
const WORKER_ROUTED_GRAMMAR_STATE: Record<string, "ready" | "failed"> = {};

// An empty tree for a side whose AST the worker didn't supply; the renderer
// treats it as "no highlighting" (that side plain — fail-open).
const EMPTY_WORKER_AST: DiffAST = { type: "root", children: [] };

/**
 * A @git-diff-view highlighter backed by ASTs the worker already tokenized:
 * `getAST` looks the side up by the raw text's djb2 hash — no engine on the
 * main thread; a miss returns the empty AST (that side plain). Handed to the
 * view as `registerHighlighter`, whose effect runs `initSyntax` on the view's
 * OWN clone in place — so the ASTs paint without rebuilding the DiffFile.
 * `name`/`type` must stay `"shiki"`/`"style"`: the core's re-entry guards
 * (DiffFile.initSyntax, File.doSyntax) bail on a highlighter matching the one
 * already applied, so a pair matching the interim "lowlight" pass would keep it.
 * Hunk-scoped like the worker's Shiki highlighter that produced the ASTs, so
 * both carry the same (absent) line cap and placeholder-skipping `processAST`.
 */
function precomputedHighlighter(asts: WorkerAsts): DiffFileHighlighter {
  return {
    name: "shiki",
    type: "style",
    maxLineToIgnoreSyntax: HUNK_SCOPED_MAX_LINES,
    setMaxLineToIgnoreSyntax: () => undefined,
    ignoreSyntaxHighlightList: [],
    setIgnoreSyntaxHighlightList: () => undefined,
    getAST: (raw: string) =>
      asts.sides.find((s) => s.rawHash === djb2(raw))?.ast ?? EMPTY_WORKER_AST,
    processAST: hunkScopedProcessAST,
    hasRegisteredCurrentLang: () => true,
  };
}
// Content mode reads and highlights BOTH whole files over IPC (≈2× the hunk
// path's cost), so it keeps the original, tighter 100KB budget.
const CONTENT_HIGHLIGHT_MAX_CHARS = 100_000;

// Pin the highlight.js singleton's line cap: the core gates its whole-buffer
// pass on the RECONSTRUCTED file's line count — the library's default 2000
// would drop a small edit deep in a big file. Placeholder lines tokenize at
// ~5–20µs (≤~200ms one-time here); real-content cost is bounded by the char
// budgets above. Past the cap, createDiffFile routes to the hunk-scoped hljs
// highlighter instead (see {@link pastSyntaxCap}).
highlighter.setMaxLineToIgnoreSyntax(SYNTAX_LINE_CAP);
// Same singleton, gap isolation: a hunk-reconstructed buffer is tokenized per
// contiguous non-blank run, so an unclosed construct at a hunk boundary can't
// bleed to EOF. An explicit call, not a side-effect import, so it can't be
// tree-shaken.
installHljsGapIsolation();
// Before any tokenize, and before ensureCustomLanguages (createDiffFile) so a
// user grammar registered under `typescript`/`tsx`/`javascript`/`markdown`
// still wins.
installPatchedJsGrammars(highlighter.getHighlighterEngine());

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
    // plain; the rebuild that picks it up rides useShikiRouting's
    // `holdForGrammar` turning false.
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
    const file = DiffFile.createInstance(data);
    file.initRaw();
    // Gate on the char budget for the engine this diff routes to (~8× apart —
    // see the constants), counting both whole files in content mode since this
    // pass tokenizes them. Line count only picks the hljs highlighter: the
    // singleton's whole-buffer pass below the cap, the hunk-scoped one past it.
    if (
      lang &&
      !overHighlightBudget(highlightCostLength(text.length, content), useShiki)
    ) {
      if (useShiki) {
        file.initSyntax({ registerHighlighter: shikiDiffHighlighter() });
      } else if (pastSyntaxCap(text)) {
        file.initSyntax({ registerHighlighter: hunkScopedHljsHighlighter });
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
 * its final layout instead of hunk-only then rebuilt. `hold` is true while a
 * refresh's text and reads still disagree (see file-content-gate.ts): callers
 * keep their previous build on screen rather than build a paint the rest of
 * the refresh would restructure, so each refresh paints once. The rev pair MUST
 * match the diff's own old/new. `diffText`/`filePath` should already be
 * deferred.
 */
export function useFileContent(
  repoPath: string | undefined,
  filePath: string,
  // The old side's path: the diff's rename source, else `filePath`.
  oldPath: string,
  diffText: string,
  contentRevs?: DiffContentRevs,
  // Max diff size before content mode engages: each host's render cap, so a
  // capped render is never content mode. The staging view passes
  // stagingContentMaxLines(showFull), its own cap until Show full diff.
  maxDiffLines: number = DIFF_LINE_CAP,
  // Keep the shown build whatever its reads do (a view held on purpose).
  frozen = false,
): {
  content: { old: string; new: string } | null;
  pending: boolean;
  hold: boolean;
  /** An enabled side read is fetching, a refetch of cached data included. */
  fetching: boolean;
} {
  const oldRev = contentRevs?.oldRev;
  const newRev = contentRevs?.newRev;
  const wantContent =
    !!repoPath && !!contentRevs && realLineCount(diffText) <= maxDiffLines;
  const oldQ = useFileAtRev(
    repoPath ?? "",
    oldRev ?? null,
    oldPath,
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
  // read with a defined rev = the file is absent there (added/deleted) → "",
  // and so does a refused one, whose payload carries no base64.
  const oldB64 = oldQ.data?.base64 ?? null;
  const newB64 = newQ.data?.base64 ?? null;
  const oldText = useMemo(
    () => (oldRev !== undefined && oldB64 ? decodeBase64Utf8(oldB64) : ""),
    [oldRev, oldB64],
  );
  const newText = useMemo(
    () => (newRev !== undefined && newB64 ? decodeBase64Utf8(newB64) : ""),
    [newRev, newB64],
  );
  // Usable once the enabled side-reads settle and both files fit the highlight
  // budget (a 1-line change in a huge file stays hunk-only, no whole-file walk).
  const oldSettled =
    oldRev === undefined || !(oldQ.isPending && oldQ.errorUpdateCount === 0);
  const newSettled =
    newRev === undefined || !(newQ.isPending && newQ.errorUpdateCount === 0);
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
  // the paint rather than build a hunk-only diff it will restructure. Only a
  // first read pends: a background refetch of cached data must never re-blank,
  // nor one of a failed read, which react-query resets to pending each time.
  const pending = wantContent && (!oldSettled || !newSettled);

  // The inputs of the build on screen, and the one whose hold ran its bound.
  const [painted, setPainted] = useState<Painted | null>(null);
  const [expiredFor, setExpiredFor] = useState<Painted | null>(null);
  const now = {
    reads: contentReadsKey(filePath, oldRev, newRev, oldPath),
    text: diffText,
    oldText,
    newText,
  };
  const oldFetching = oldRev !== undefined && oldQ.isFetching;
  const newFetching = newRev !== undefined && newQ.isFetching;
  const decision = contentBuildGate({
    wantContent,
    oldSettled,
    newSettled,
    oldFetching,
    newFetching,
    ...changesSince(painted, now),
    boundExpired: painted !== null && expiredFor === painted,
    frozen,
  });
  const nextPainted = paintedAfter(painted, decision, pending, now, {
    wantContent,
    inFlight: oldFetching || newFetching,
  });
  if (nextPainted !== painted) setPainted(nextPainted);
  const hold = decision === "hold-previous";
  // The bound runs from the hold's start: no render during a hold moves
  // `painted`.
  useEffect(() => {
    if (!hold || frozen || painted === null) return;
    const bound = window.setTimeout(
      () => setExpiredFor(painted),
      HOLD_BOUND_MS,
    );
    return () => window.clearTimeout(bound);
  }, [hold, frozen, painted]);
  const fetching = oldFetching || newFetching;
  return useMemo(
    () => ({
      content: useContent ? { old: oldText, new: newText } : null,
      pending,
      hold,
      fetching,
    }),
    [useContent, oldText, newText, pending, hold, fetching],
  );
}

/**
 * Shiki routing for one diff: lazily loading the built-in grammar it needs,
 * holding the paint until that settles, triggering the rebuild that picks it up,
 * and off-thread worker ASTs for an over-budget Shiki-routed diff. Shared by
 * both {@link createDiffFile} call sites so they apply the same routing rules.
 *
 * Contract: the rebuild that picks a loaded grammar up rides `holdForGrammar`
 * turning false. Callers still list `grammarState` in their
 * {@link createDiffFile} memo's deps for biome and an uncompiled caller; the
 * compiler derives a compiled caller's keys from the body and drops it.
 * `workerHighlighter` goes to the view as its `registerHighlighter` prop and
 * must NOT be a build dep: keeping the DiffFile identity stable across the
 * ASTs' arrival is what preserves the view's expansion state.
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
  workerHighlighter: DiffFileHighlighter | undefined;
} {
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
  // No line-count gate here: a hunk deep in a big file tokenizes hunk-scoped
  // (Shiki always, hljs past SYNTAX_LINE_CAP), so it consumes a grammar, a paint
  // hold, and worker ASTs exactly like a small file; the char budgets bound it.
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
      // the worker loads its own grammar copy. Deliberately judged on the diff
      // text alone, so a content-mode mount fetches in parallel with its reads;
      // a fetch the content then routes to the worker can't rebuild the paint:
      // over budget `holdForGrammar` stays false, so its settle flips nothing
      // (the frozen rebuild key below backstops an uncompiled caller).
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
  // routed OFF on purpose. An over-budget hljs file sends NO request (the
  // clone's own hljs pass covers it, plain past SYNTAX_LINE_CAP). A builtin
  // Shiki lang whose grammar the main thread hasn't loaded also routes here —
  // the worker loads its own copy. A custom `tmGrammar` routes directly: its
  // registration happens lazily inside createDiffFile with no rebuild trigger,
  // and the grammar (unlike module state) is available on the first render.
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
  // Content-aware like createDiffFile's sync gate, so the worker takes exactly
  // the content-mode paints the main thread won't tokenize.
  const overBudget =
    !!lang &&
    overHighlightBudget(
      highlightCostLength(text.length, content),
      useShikiWorker,
    );
  const workerAsts = useWorkerHighlight({
    // Shiki-routed + over budget only. Don't request while whole-file reads are
    // still settling — the worker input would be built on interim text and
    // superseded. (Over budget we never hold the paint on grammarPending, so it
    // isn't gated on here.)
    enabled: overBudget && useShikiWorker && !contentPending,
    filePath,
    text,
    lang: lang ?? null,
    content,
    tmGrammar,
  });
  // Memoized: the view's `registerHighlighter` effect re-runs on identity, so a
  // fresh object each render would re-tokenize the clone every render.
  const workerHighlighter = useMemo(
    () => (workerAsts ? precomputedHighlighter(workerAsts) : undefined),
    [workerAsts],
  );

  // Over budget the main thread never Shiki-tokenizes, so holding the paint for
  // a grammar only the worker needs would just delay the interim paint. Under
  // budget, hold — so the lazy-grammar rebuild still lands in one paint.
  const holdForGrammar = grammarPending && !overBudget;

  // Over budget the main thread never Shiki-tokenizes, so a grammar settling
  // then must not rebuild the interim paint. `holdForGrammar` staying false
  // holds that for compiled callers, whose memo keys drop `grammarState`; the
  // frozen key backstops an uncompiled caller that still keys on it.
  return {
    holdForGrammar,
    grammarState: overBudget ? WORKER_ROUTED_GRAMMAR_STATE : grammarState,
    workerHighlighter,
  };
}

/** What one mounted line anchor carries between commits. */
interface LineAnchorRuntime {
  /** The reading position a switch or an expand restores. */
  anchor: LineAnchor | null;
  /** The rows sampling bisects, walked once per build: a new build or any
   *  child mutation under the scroller drops the list. */
  rows: ArrayLike<Element> | null;
  /** Set while a restore waits for rows: sampling pauses, so the rowless
   *  commit's own clamp can't overwrite the anchor the restore reads. */
  armed: { tookOver: boolean; disarm: () => void } | null;
  /** Set by a restore until the next input anywhere or RESTORE_BOUND_MS: the
   *  snapshot it placed stays the anchor, so the restore's own scrolls (a clamp
   *  at the scroll end included) never re-sample it, and `place` puts back a
   *  line a scroll or a re-laid layout moved off its offset. */
  frozen: { place: () => void; release: () => void } | null;
  /** The anchor `keepLine` read ahead of an expand, and the build it read. */
  kept: { anchor: LineAnchor | null; content: unknown } | null;
}

// Inputs that hand the reading position back to scrolling. Document-wide, and
// they reach the capture listener before the toggle or press they start acts.
const ANCHOR_RELEASE_INPUTS = [
  "wheel",
  "touchmove",
  "keydown",
  "pointerdown",
] as const;

function releaseLineAnchor(rt: LineAnchorRuntime) {
  rt.frozen?.release();
}

function freezeLineAnchor(
  rt: LineAnchorRuntime,
  scroller: HTMLElement,
  anchor: LineAnchor,
  split: boolean,
) {
  releaseLineAnchor(rt);
  const place = () => {
    placeLineAnchor(scroller, anchor, split);
  };
  // A layout can re-lay its rows after the restore (wrapped rows settling to
  // their height) with no scroll event, so a content resize re-places too. The
  // children are re-observed when the scroller's content root is replaced.
  const resized = new ResizeObserver(place);
  const watch = () => {
    resized.disconnect();
    for (const child of scroller.children) resized.observe(child);
  };
  const swapped = new MutationObserver(watch);
  const timer = setTimeout(release, RESTORE_BOUND_MS);
  function release() {
    clearTimeout(timer);
    resized.disconnect();
    swapped.disconnect();
    for (const type of ANCHOR_RELEASE_INPUTS)
      document.removeEventListener(type, release, true);
    if (rt.frozen?.release === release) rt.frozen = null;
  }
  watch();
  swapped.observe(scroller, { childList: true });
  for (const type of ANCHOR_RELEASE_INPUTS)
    document.addEventListener(type, release, { capture: true, passive: true });
  rt.anchor = anchor;
  rt.frozen = { place, release };
}

/** Puts the anchored line back at its offset when its row is rendered;
 *  returns whether it was. A write within a pixel of the target is skipped,
 *  so a re-placement never feeds its own scroll event. */
function placeLineAnchor(
  scroller: HTMLElement,
  anchor: LineAnchor,
  split: boolean,
): boolean {
  if (anchor.atTop) {
    if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
    return true;
  }
  const row = anchorRow(scroller, anchor, split);
  if (row === null) return false;
  const top = anchorScrollTop(scroller, row, anchor);
  if (Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTop = top;
  return true;
}

/** Restores `anchor` in the layout `armedFor.mode` names: in this commit when
 *  its row is here, else once it lands, yielding to a wheel, touch scroll,
 *  press, focus move or scroll key in the scroller once armed (a latch, never a
 *  scrollTop compare), to another mode or file than `armedFor` (read from
 *  `live`), and to RESTORE_BOUND_MS. Returns the wait's disarm. Once placed,
 *  the line is frozen (`freezeLineAnchor`). */
function restoreLineAnchor(
  rt: LineAnchorRuntime,
  scroller: HTMLElement,
  anchor: LineAnchor,
  armedFor: { mode: string; file: string },
  live: () => { mode: string; file: string },
): (() => void) | undefined {
  const split = armedFor.mode === "split";
  if (placeLineAnchor(scroller, anchor, split)) {
    freezeLineAnchor(rt, scroller, anchor, split);
    return undefined;
  }
  const start = performance.now();
  const armed = { tookOver: false, disarm };
  rt.armed = armed;
  function disarm() {
    mo.disconnect();
    clearTimeout(timer);
    document.removeEventListener("wheel", latch, true);
    document.removeEventListener("touchmove", latch, true);
    document.removeEventListener("keydown", latchKey, true);
    document.removeEventListener("pointerdown", latch, true);
    document.removeEventListener("focusin", latch, true);
    if (rt.armed === armed) rt.armed = null;
  }
  const step = () => {
    const now = live();
    const next = restoreDecision({
      armedMode: armedFor.mode,
      armedFile: armedFor.file,
      mode: now.mode,
      file: now.file,
      tookOver: armed.tookOver,
      elapsedMs: performance.now() - start,
      rowReady: anchorRow(scroller, anchor, split) !== null,
    });
    if (next === "wait") return;
    disarm();
    if (next === "fire" && placeLineAnchor(scroller, anchor, split))
      freezeLineAnchor(rt, scroller, anchor, split);
  };
  const latch = (e: Event) => {
    if (!(e.target instanceof Node) || !scroller.contains(e.target)) return;
    armed.tookOver = true;
    step();
  };
  const latchKey = (e: KeyboardEvent) => {
    if (PANE_SCROLL_KEYS.has(e.key)) latch(e);
  };
  const mo = new MutationObserver(step);
  const timer = setTimeout(disarm, RESTORE_BOUND_MS);
  const passive = { capture: true, passive: true };
  document.addEventListener("wheel", latch, passive);
  document.addEventListener("touchmove", latch, passive);
  document.addEventListener("keydown", latchKey, passive);
  document.addEventListener("pointerdown", latch, true);
  document.addEventListener("focusin", latch, true);
  mo.observe(scroller, { childList: true, subtree: true });
  return disarm;
}

/** Keeps the top visible line in place across a split/unified switch, whatever
 *  flipped the effective mode (the toggle, the setting, the narrow-pane
 *  override), and across an expand of the same diff: the layouts lay out at
 *  different heights and an expand replaces every row, so a kept scrollTop
 *  shows another line. Scrolling samples the anchor; a switch snapshots it, as
 *  does the returned `keepLine` called just before an expand, and the next
 *  layout or build restores it with an absolute scrollTop. No scroller, no
 *  restore. `content` is the built diff on screen: any other new build under
 *  the same path and mode re-reads the anchor from its rows. */
export function useModeLineAnchor(
  scrollerRef: { readonly current: HTMLElement | null } | undefined,
  mode: string,
  file: string,
  content: unknown,
): () => void {
  const runtime = useRef<LineAnchorRuntime>({
    anchor: null,
    rows: null,
    armed: null,
    frozen: null,
    kept: null,
  });
  // The last mode and file applied, so an <Activity> re-show restores only
  // when the mode changed while hidden; a new file drops the anchor.
  const appliedRef = useRef({ mode, file });
  const contentRef = useRef({ content, mode, file });
  useEffect(() => {
    const scroller = scrollerRef?.current;
    if (!scroller) return;
    const rt = runtime.current;
    let frame = 0;
    const sample = () => {
      frame = 0;
      if (rt.armed !== null || rt.frozen !== null) return;
      rt.rows ??= anchorRows(scroller);
      rt.anchor = captureLineAnchor(scroller, rt.rows);
    };
    const onScroll = () => {
      if (rt.frozen !== null) {
        rt.frozen.place();
        return;
      }
      if (frame === 0 && rt.armed === null)
        frame = requestAnimationFrame(sample);
    };
    const drop = new MutationObserver(() => {
      rt.rows = null;
    });
    drop.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      drop.disconnect();
      rt.rows = null;
      releaseLineAnchor(rt);
    };
  }, [scrollerRef]);
  // Its cleanup is the disarm, so the next mode or file edge, a hide and an
  // unmount each end a wait.
  useLayoutEffect(() => {
    const rt = runtime.current;
    const applied = appliedRef.current;
    appliedRef.current = { mode, file };
    if (applied.file !== file) {
      rt.anchor = null;
      rt.kept = null;
      releaseLineAnchor(rt);
      return;
    }
    const anchor = rt.anchor;
    const scroller = scrollerRef?.current;
    if (applied.mode === mode || anchor === null || !scroller) return;
    return restoreLineAnchor(
      rt,
      scroller,
      anchor,
      { mode, file },
      () => appliedRef.current,
    );
  }, [mode, file, scrollerRef]);
  // A new build under a kept scrollTop (another commit of the same path, a
  // stage or unstage) moves the lines without a scroll event, so the anchor is
  // re-read from its committed rows; an expand `keepLine` read restores that
  // read instead. Either way a wait armed for the build it replaces ends: its
  // snapshot never lands in another build. Not in the commit a mode or file
  // edge ran in: that edge owns the anchor.
  useLayoutEffect(() => {
    const rt = runtime.current;
    const prev = contentRef.current;
    contentRef.current = { content, mode, file };
    if (prev.content === content) return;
    const kept = rt.kept;
    rt.kept = null;
    rt.rows = null;
    const scroller = scrollerRef?.current;
    if (!scroller || prev.mode !== mode || prev.file !== file) return;
    rt.armed?.disarm();
    if (kept?.anchor && kept.content === prev.content)
      return restoreLineAnchor(
        rt,
        scroller,
        kept.anchor,
        { mode, file },
        () => appliedRef.current,
      );
    releaseLineAnchor(rt);
    rt.rows = anchorRows(scroller);
    rt.anchor = captureLineAnchor(scroller, rt.rows);
  }, [content, mode, file, scrollerRef]);
  // Called just before an expand of the diff on screen: reads the line the
  // pane shows now, which the expanded build restores.
  return useCallback(() => {
    const rt = runtime.current;
    const scroller = scrollerRef?.current;
    if (!scroller) return;
    rt.kept = {
      anchor: rt.armed !== null ? rt.anchor : captureLineAnchor(scroller),
      content: contentRef.current.content,
    };
  }, [scrollerRef]);
}

/** The per-side line -> render() maps the vendored DiffView consumes. */
type AnchorExtendData = Record<string, { data: { render: () => ReactNode } }>;

function RenderedDiff({
  filePath,
  oldPath,
  text,
  repoPath,
  contentRevs,
  lineAnchors,
  lineWidget,
  forceUnified,
  revealLanding,
  scrollerRef,
}: {
  filePath: string;
  oldPath?: string;
  text: string;
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  lineAnchors?: DiffLineAnchor[];
  lineWidget?: LineWidget;
  forceUnified?: boolean;
  revealLanding?: { readonly current: HTMLElement | null };
  scrollerRef?: { readonly current: HTMLElement | null };
}) {
  const settings = useSettings();
  const isDark = useIsDark();
  // The narrow-pane override renders unified without ever writing the setting,
  // so widening the pane restores the user's split preference on its own.
  const viewMode = forceUnified
    ? "unified"
    : (settings.data?.diffViewMode ?? "unified");

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
  const deferredOldPath = useDeferredValue(oldPath ?? filePath);

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
  // diff is built ONCE in its final layout rather than rebuilt (the "flash"),
  // and keep the previous build up through a refresh's `contentHold`.
  const {
    content,
    pending: contentPending,
    hold: contentHold,
  } = useFileContent(
    repoPath,
    deferredPath,
    deferredOldPath,
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

  const { holdForGrammar, grammarState, workerHighlighter } = useShikiRouting({
    filePath: deferredPath,
    text: shown,
    content: content ?? null,
    contentPending: contentPending || contentHold,
    blocked,
    syntaxMap,
    customLanguages,
  });

  // grammarState: inert once compiled; see useShikiRouting's contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: grammarState stays listed for the uncompiled path; the rebuild rides holdForGrammar
  const builtDiffFile = useMemo(() => {
    if (blocked || contentPending || holdForGrammar || contentHold) return null;
    const file = createDiffFile(
      deferredPath,
      shown,
      { syntaxMap, customLanguages },
      content ?? undefined,
    );
    // Rows prebuilt for both layouts, as the library's own mount effect builds
    // them: its view remounts on every rebuild (Show full diff among them), and
    // rows built only in that effect would leave the scroller rowless for a
    // commit, which clamps it to the top. The layout stays out of the deps,
    // since a new build would drop the user's expanded context.
    file?.buildSplitDiffLines();
    file?.buildUnifiedDiffLines();
    return file;
  }, [
    shown,
    deferredPath,
    syntaxMap,
    customLanguages,
    content,
    blocked,
    contentPending,
    holdForGrammar,
    contentHold,
    grammarState,
  ]);
  // Through a refresh's hold, the build already on screen, with the worker
  // highlighting painted on it (the worker answers nothing while held).
  const diffFile = useRetained(builtDiffFile, !contentHold);
  const shownHighlighter = useRetained(workerHighlighter, !contentHold);

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

  const mapCrossSideLine = useCallback(
    (
      lineNumber: number,
      fromSide: "old" | "new",
      toSide: "old" | "new",
    ): number | null =>
      crossSideLine(multiSelectRef, lineNumber, fromSide, toSide),
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
        <div
          data-diff-line-widget
          className="m-2 rounded-none border bg-popover p-3 font-sans text-xs text-popover-foreground shadow-md"
        >
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

  // Inside a diff-pane slot, settle waits for THIS diffFile's first row: the
  // library builds rows in its own passive effect, so a built diffFile can
  // still paint rowless. A diff with no hunk lines never gets a row, so it
  // settles at build. The probe (a sibling just before the view) and its
  // observer exist only in a slot, leaving every other host's tree as it was.
  const inSlot = useInDiffPaneSlot();
  const rowsProbeRef = useRef<HTMLSpanElement>(null);
  const [rowsFor, setRowsFor] = useState<DiffFile | null>(null);
  useEffect(() => {
    const probe = rowsProbeRef.current;
    const host = probe?.parentElement;
    if (!probe || !host || !diffFile || !diffRendersRows(diffFile)) return;
    const hasRow = () =>
      probe.nextElementSibling?.querySelector("tr[data-line]") != null;
    if (hasRow()) {
      setRowsFor(diffFile);
      return;
    }
    const mo = new MutationObserver(() => {
      if (!hasRow()) return;
      mo.disconnect();
      setRowsFor(diffFile);
    });
    mo.observe(host, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [diffFile]);
  // A refresh's hold over a paint that never built (a grammar was still
  // loading) has nothing to keep, so it renders nothing too.
  const holdBlank = contentHold && diffFile === null;
  // The blocked placeholder is final; the pending arm below renders nothing.
  useReportPaneSettled(
    blocked ||
      (!contentPending &&
        !holdForGrammar &&
        !holdBlank &&
        (diffFile === null ||
          !diffRendersRows(diffFile) ||
          rowsFor === diffFile)),
  );

  // Show full diff takes its own button away, as does a same-file refresh that
  // uncaps the diff: only focus the button held as it left, in that same file,
  // lands, without scrolling, on the diff's own named group (so focus stays in
  // the diff and announces it), else on `revealLanding`. The cleanup reads the
  // last committed path, so a file switch's unmount never lands.
  const diffLandingRef = useRef<HTMLDivElement>(null);
  const footerFocus = useRef<{
    button: HTMLElement;
    hadFocus: boolean;
    forPath: string;
  } | null>(null);
  const committedPath = useRef(deferredPath);
  const captureFooter = useCallback(
    (node: HTMLButtonElement | null) => () => {
      if (node !== null)
        footerFocus.current = {
          button: node,
          hadFocus: node.contains(document.activeElement),
          forPath: committedPath.current,
        };
    },
    [],
  );
  // False only inside a held or preparing diff-pane slot, whose inert subtree
  // must not take focus.
  const { interactive } = useDiffPaneHold();
  // No dependency array: it consumes the capture every commit, after that
  // commit's ref cleanups wrote it. A button still mounted (a re-render that
  // kept it focused) never counts as taken away; defence in depth, as the
  // identity-stable capture callback only fires on a detach.
  useLayoutEffect(() => {
    const held = footerFocus.current;
    footerFocus.current = null;
    if (
      held !== null &&
      held.forPath === deferredPath &&
      !held.button.isConnected &&
      interactive
    )
      landHunkFocus(held, diffLandingRef.current ?? revealLanding?.current);
    committedPath.current = deferredPath;
  });
  const keepLine = useModeLineAnchor(
    scrollerRef,
    viewMode,
    deferredPath,
    diffFile,
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
  if (contentPending || holdForGrammar || holdBlank) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  return (
    // The Show full landing: a named group, so focus that lands here stays in
    // the diff (scroll keys keep reading it) and announces which diff it is.
    <div
      ref={diffLandingRef}
      role="group"
      aria-label={`Diff of ${deferredPath}`}
      tabIndex={-1}
      className="outline-none"
    >
      {inSlot && <span ref={rowsProbeRef} hidden />}
      {lineWidget?.enabled ? (
        // Line-comment mode: the multi-select variant adds clickable line numbers
        // and drag-to-select, opening the composer below the line. Opt-in only.
        <DiffViewWithMultiSelect<{ render: () => ReactNode }>
          ref={multiSelectRef}
          diffFile={diffFile}
          // Worker ASTs land as a highlighter PROP, not a rebuild: the view's
          // effect applies them to its own clone, so expansion state survives.
          registerHighlighter={shownHighlighter}
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
          registerHighlighter={shownHighlighter}
          diffViewMode={diffViewMode}
          diffViewTheme={isDark ? "dark" : "light"}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={12}
          extendData={extendData}
          renderExtendLine={renderExtendLine}
        />
      )}
      <DiffCapFooter
        hidden={hidden}
        shortened={shortened}
        onShowFull={() => {
          keepLine();
          setShowFull(true);
        }}
        buttonRef={captureFooter}
      />
    </div>
  );
}

const SHOW_FULL_DIFF_LABEL = "Show full diff";

/**
 * The strip under a capped or shortened diff: what was hidden or shortened, and
 * Show full diff while lines are hidden. The one source of this copy for every
 * diff host. A host that holds its diff's actions passes `held`/`heldReason`
 * (the button then explains its hold and keeps its tab stop) and its own
 * `onButtonKeyDown`; without them the button is a plain Button.
 */
export function DiffCapFooter({
  hidden,
  shortened,
  onShowFull,
  onButtonKeyDown,
  held,
  heldReason,
  buttonRef,
}: {
  hidden: number;
  shortened: number;
  onShowFull: (e: ReactMouseEvent<HTMLElement>) => void;
  onButtonKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  held?: boolean;
  heldReason?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  if (hidden <= 0 && shortened <= 0) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {hidden > 0 && (
        <span>
          {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}{" "}
          hidden for performance
        </span>
      )}
      {shortened > 0 && (
        <span>
          {shortened.toLocaleString()} long {shortened === 1 ? "line" : "lines"}{" "}
          shortened
          {hidden > 0 ? "" : " for performance"}
        </span>
      )}
      {hidden > 0 &&
        (held === undefined && heldReason === undefined ? (
          <Button
            ref={buttonRef}
            size="xs"
            variant="outline"
            onClick={onShowFull}
          >
            {SHOW_FULL_DIFF_LABEL}
          </Button>
        ) : (
          <DisabledReasonButton
            ref={buttonRef}
            size="xs"
            variant="outline"
            disabled={held}
            reason={heldReason}
            onKeyDown={onButtonKeyDown}
            onClick={onShowFull}
          >
            {SHOW_FULL_DIFF_LABEL}
          </DisabledReasonButton>
        ))}
    </div>
  );
}

/**
 * The diff toolbar's view options: one checkbox for the app-wide whitespace
 * mode. The flip waits for the menu's close to settle: Base UI returns focus
 * to the trigger only when the popup unmounts, and a toolbar swap before that
 * would drop focus to <body> from inside the portaled popup.
 */
export function DiffViewOptionsMenu({
  onToggle,
}: {
  onToggle: (next: boolean) => void;
}) {
  const hidden = useHideWhitespace();
  const [open, setOpen] = useState(false);
  // The pressed value while the close settles; the menu takes no second
  // instruction meanwhile.
  const [pending, setPending] = useState<boolean | null>(null);
  const { onOpenChangeComplete, waitClosed } = useCloseSettled(open);
  const label = hidden
    ? "View options, whitespace changes hidden"
    : "View options";
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next && pending !== null) return;
        setOpen(next);
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DropdownMenuTrigger
        onKeyDown={(e) => {
          // The item's close returns focus here while the key is still held:
          // its auto-repeat would reopen the menu, so only a fresh press opens.
          if (e.repeat && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.preventBaseUIHandler();
          }
        }}
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            className="relative"
          />
        }
      >
        <GearSixIcon aria-hidden />
        {hidden && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 bg-primary"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={pending ?? hidden}
          closeOnClick
          onKeyDown={(e) => {
            // Items activate on keydown with no repeat check, so a held key
            // would flip the mode twice.
            if (e.repeat && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              e.preventBaseUIHandler();
            }
          }}
          onCheckedChange={(next) => {
            if (pending !== null) return;
            setPending(next);
            void waitClosed().then(() => {
              onToggle(next);
              setPending(null);
            });
          }}
        >
          Hide whitespace changes
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  previewRev,
  lineAnchors,
  lineWidget,
  stagingSide,
}: {
  filePath: string;
  diff: UseQueryResult<FileDiff>;
  repoPath?: string;
  imageRevs?: ImageRevs;
  contentRevs?: DiffContentRevs;
  /** See {@link DiffContent}'s prop of the same name — preview only. */
  previewRev?: string;
  lineAnchors?: DiffLineAnchor[];
  lineWidget?: LineWidget;
  /** See {@link DiffContent}'s prop of the same name. */
  stagingSide?: StagingSide;
}) {
  return (
    <DiffContent
      filePath={filePath}
      data={diff.data}
      isPending={diff.isPending}
      isError={diff.isError}
      isPaused={diff.isPaused}
      isFetching={diff.isFetching}
      onRetry={() => void diff.refetch()}
      repoPath={repoPath}
      imageRevs={imageRevs}
      contentRevs={contentRevs}
      previewRev={previewRev}
      dataIsPlaceholder={diff.isPlaceholderData}
      lineAnchors={lineAnchors}
      lineWidget={lineWidget}
      stagingSide={stagingSide}
      whitespaceControl
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
  isPaused = false,
  isFetching = false,
  onRetry,
  repoPath,
  imageRevs,
  contentRevs,
  previewRev,
  dataIsPlaceholder,
  lineAnchors,
  lineWidget,
  stagingSide,
  anchorCommit,
  whitespaceControl = false,
}: {
  filePath: string;
  /** Absent only when the source query has nothing to show; never an empty
   *  stand-in, which would read as "No changes to show". */
  data: FileDiff | undefined;
  isPending: boolean;
  /** Beside `data`, a failed refresh: the diff stays up under a notice. */
  isError: boolean;
  /** The source read is parked offline (react-query's `isPaused`). */
  isPaused?: boolean;
  /** The source read has a fetch in flight; over `isError` it hasn't settled
   *  yet. Omitted, an error reads as settled. */
  isFetching?: boolean;
  /** Refetches the source query; offered only on a failed refresh, since a
   *  parked read resumes by itself once back online. */
  onRetry?: () => void;
  /** With `imageRevs`, binary image files render as an image comparison. */
  repoPath?: string;
  imageRevs?: ImageRevs;
  /** Revs to read full file text from for highlight context (text diffs). */
  contentRevs?: DiffContentRevs;
  /** Rev to read the NEW side from for markdown preview when the diff is a
   *  server-provided patch with no trustworthy local rev pair (PR surfaces).
   *  Feeds ONLY the preview toggle/pane — never content-mode highlighting
   *  (silently-capped forge patches would mis-map tokens) and never image revs. */
  previewRev?: string;
  /** True while `data` is another query key's retained result (placeholder). Content
   *  mode token-maps whole-file reads at the CURRENT revs onto `data`'s hunks, so a
   *  placeholder pairing would highlight the wrong lines — the preview pane and image
   *  arms read whole files by rev and stay correct for the new selection. */
  dataIsPlaceholder?: boolean;
  /** Line-anchored annotations (e.g. PR review threads). Absent = no anchors. */
  lineAnchors?: DiffLineAnchor[];
  /** Inline composer opened from a diff line (PR review). Absent = read-only. */
  lineWidget?: LineWidget;
  /** Set only by the working-tree staging host; enables the non-UTF-8 note.
   *  Absent = read-only host, no note. */
  stagingSide?: StagingSide;
  /** PR surfaces only: the commit oid gating the binary-size lookups (PR head on Files,
   *  the commit on Commits). undefined = local surface. See BinaryFileSummary. */
  anchorCommit?: string | null;
  /** Shows the view-options gear and answers the whitespace palette action.
   *  Only {@link DiffSurface} sets it, so the remote PR hosts get neither. */
  whitespaceControl?: boolean;
}) {
  // The pane measures itself: this surface mounts at widths from a full window
  // down to a rail-flanked column, and both the split gate and the toolbar's
  // container queries key off THIS box, not the viewport.
  const [paneRef, paneWidth] = useContainerWidth<HTMLDivElement>();
  // Pre-measure (`null`) is deliberately NOT an override, so the first paint
  // matches the persisted preference instead of flashing split→unified→split.
  const narrowPane = paneWidth !== null && paneWidth < SPLIT_MIN_CONTAINER_PX;

  // The picker's trigger is hidden below @md, so the palette action is its only
  // route at narrow widths — which makes the open state the toolbar's to own.
  const [langOpen, setLangOpen] = useState(false);
  // Raw ⇄ Preview for markdown/MDX files. Per-file and never persisted — a
  // sticky global "preview" would be meaningless on the non-markdown files
  // that are most of a diff list, so every file opens on Raw.
  const [mdView, setMdView] = useState<MarkdownDiffView>("raw");
  const [prevMdPath, setPrevMdPath] = useState(filePath);
  // Guarded same-component reset during render (React's adjust-state-when-
  // props-change idiom, same as RenderedDiff's prevPath resets): it converges
  // before commit, where an effect would paint the outgoing file's view first.
  if (prevMdPath !== filePath) {
    setPrevMdPath(filePath);
    if (mdView !== "raw") setMdView("raw");
  }
  const {
    wrapRef: langWrapRef,
    controlsRef,
    returnFocusIfTriggerHidden,
  } = useHiddenTriggerFocus();
  // Computed above the early-return chain (which the `emptyDiff` arm joins, so
  // the text is trimmed once) because the registrations below are hooks: offer
  // each action only in the states that actually render its control.
  const emptyDiff = data !== undefined && data.text.trim() === "";
  // A section that changed no content (an empty file, a mode change, a pure
  // rename or copy) has no body for a toolbar to configure.
  const dataText = data?.text;
  const headerOnly = useMemo(
    () => (dataText === undefined ? null : classifyHeaderOnlyDiff(dataText)),
    [dataText],
  );
  // The same path check as the toolbar's: another file's retained answer never
  // shows this state under the path row of the file loading.
  const whitespaceOnly =
    data !== undefined &&
    data.filePath === filePath &&
    data.whitespaceOnly === true;
  // A failed refresh keeps the diff, and its toolbar, on screen.
  const showsToolbar =
    !isPending &&
    data !== undefined &&
    data.filePath === filePath &&
    !data.isBinary &&
    !emptyDiff &&
    headerOnly === null &&
    !whitespaceOnly;
  // Preview's rev source: the diff's own pair where there is one, else the
  // new-side-only `previewRev`. Deliberately not merged into `contentRevs` — a
  // previewRev host has no old side and must not light up content mode.
  const previewRevs: DiffContentRevs | undefined =
    contentRevs ??
    (previewRev === undefined ? undefined : { newRev: previewRev });
  const canPreview =
    showsToolbar && canPreviewMarkdown(filePath, repoPath, previewRevs);
  const previewOn = canPreview && mdView === "preview";
  // Each capture node records whether it held focus in its own ref cleanup,
  // which runs before that node's removal: never React's deletion order between
  // siblings, nor a blur event that removal may not fire.
  const paneHeldFocus = useRef(false);
  const captureHeldRef = useCallback(
    (node: HTMLElement | null) => () => {
      if (node !== null && node.contains(document.activeElement))
        paneHeldFocus.current = true;
    },
    [],
  );
  // The text scroller is a capture node and the line anchor's scroller. One
  // identity-stable ref serves both, so a re-render never runs the capture's
  // cleanup, and a detached scroller is never readable.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerCaptureRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      const capture = captureHeldRef(node);
      return () => {
        capture();
        scrollerRef.current = null;
      };
    },
    [captureHeldRef],
  );
  // A load or a refetch can take the toolbar away (a new selection, the file
  // emptied, a mode-only change left): only focus the pane held as that subtree
  // left lands on the replacing arm's body (the path-row controls over an
  // image), and focus on <body> or outside the pane never moves. Declared ahead
  // of the Preview rescue, whose landing persists across arms, so a swap that
  // drops both lands on the new body.
  const armLandingRef = useRef<HTMLDivElement | null>(null);
  const armRescueRef = useRef<HTMLElement | null>(null);
  const previewRescueRef = useRef<HTMLElement | null>(null);
  const prevSwapRef = useRef({ path: filePath, toolbar: showsToolbar });
  // No dependency array: it derives both rescue refs and consumes the record
  // every commit, after that commit's ref cleanups wrote it and before the
  // hooks below run (react-dom 19.3.1 commit order). The Preview rescue also
  // passes a same-file Raw/Preview toggle from <body>; another file's swap
  // passes only held focus. The toolbar rescue falls back to the controls,
  // since the image and typechange arms render no landing.
  useLayoutEffect(() => {
    const held = paneHeldFocus.current;
    const sameToolbarFile =
      showsToolbar &&
      prevSwapRef.current.toolbar &&
      prevSwapRef.current.path === filePath;
    armRescueRef.current = held
      ? (armLandingRef.current ?? controlsRef.current)
      : null;
    previewRescueRef.current =
      held || sameToolbarFile ? controlsRef.current : null;
    prevSwapRef.current = { path: filePath, toolbar: showsToolbar };
    paneHeldFocus.current = false;
  });
  useFocusOnControlsSwap(showsToolbar, armRescueRef);
  useFocusOnControlsSwap(previewOn, previewRescueRef);
  // Bringing the toolbar back unmounts that body: only focus it held as it left
  // (read in its ref cleanup, which runs before removal) lands on the toolbar's
  // own landing, so a cold load or another file's swap never takes focus.
  const armHeldFocus = useRef(false);
  const armRef = useCallback((node: HTMLDivElement | null) => {
    armLandingRef.current = node;
    return () => {
      armHeldFocus.current =
        node !== null && node.contains(document.activeElement);
      armLandingRef.current = null;
    };
  }, []);
  const toolbarWasShown = useRef(showsToolbar);
  useLayoutEffect(() => {
    const was = toolbarWasShown.current;
    toolbarWasShown.current = showsToolbar;
    if (was || !showsToolbar) return;
    const owned = armHeldFocus.current;
    armHeldFocus.current = false;
    if (owned && document.activeElement === document.body)
      controlsRef.current?.focus({ preventScroll: true });
  }, [showsToolbar, controlsRef]);
  // False only inside a held or preparing diff-pane slot, which `inert` can't
  // shield from global hotkeys.
  const { interactive } = useDiffPaneHold();
  useHotkeyAction(
    "change-diff-language",
    () => setLangOpen(true),
    // In Preview the picker isn't mounted, so the action would open nothing.
    interactive && showsToolbar && !previewOn && Boolean(fileExt(filePath)),
  );
  useHotkeyAction(
    "toggle-markdown-preview",
    () => setMdView((v) => (v === "raw" ? "preview" : "raw")),
    interactive && canPreview,
  );
  // Every whitespace flip this pane owns goes through here: an open line
  // composer would unmount with the rebuilt view and lose its text.
  const hideWhitespace = useHideWhitespace();
  const setHideWhitespaceRaw = useSetHideWhitespace();
  function flipWhitespace(next: boolean) {
    if (scrollerRef.current?.querySelector("[data-diff-line-widget]")) {
      toast.info(WHITESPACE_COMPOSER_HELD);
      return;
    }
    setHideWhitespaceRaw(next);
  }
  // Not gated on the toolbar: the whitespace-only, binary and empty arms
  // answer it too.
  useHotkeyAction(
    "toggle-hide-whitespace",
    () => flipWhitespace(!hideWhitespace),
    interactive && whitespaceControl,
  );
  // The two arms below with a blank body: a pending read (a parked one says so
  // instead) and another key's retained data. Every other arm's own markup is
  // final. The children report their own gates: ImagePanes its reads and image
  // decodes, MarkdownDocPreview its file read, RenderedDiff its inputs and
  // first row.
  useReportPaneSettled(
    !(isPending && !isPaused) &&
      !(data !== undefined && data.filePath !== filePath),
  );

  // ~200px of unshrinkable text, so it shows only where the pane has the room;
  // the sr-only twin carries it at every width, and `aria-hidden` on the
  // visible copy keeps the two from announcing twice. Hidden in Preview, which
  // reads the full file rather than the truncated diff.
  const truncatedMeta = showsToolbar && data?.isTruncated && !previewOn && (
    <>
      <span aria-hidden className="hidden shrink-0 @2xl/diff-pane:inline">
        (truncated — diff too large)
      </span>
      <span className="sr-only">(truncated — diff too large)</span>
    </>
  );
  // Every arm renders this shell: the notice where retained data shows, then
  // the path row, then the arm's body. The row has one height in every arm,
  // so only a visible (degraded) notice coming or going moves the body on an
  // arm swap; its controls render only over a text diff (`showsToolbar`).
  const shell = (body: ReactNode, notice: ReactNode = null) => (
    <div ref={paneRef} className={DIFF_PANE_ROOT_CLASS}>
      {notice !== null && (
        <span className="contents" ref={captureHeldRef}>
          {notice}
        </span>
      )}
      <DiffPathRow
        filePath={filePath}
        meta={truncatedMeta}
        controlsRef={controlsRef}
      >
        {canPreview && (
          <span className="contents" ref={captureHeldRef}>
            <MarkdownViewToggle view={mdView} onChange={setMdView} />
          </span>
        )}
        {/* The picker and Unified/Split configure the raw diff, so they
            leave the cluster while Preview is up (the same swap this row
            already does for the working-tree selection actions). */}
        {showsToolbar && !previewOn && (
          <span className="contents" ref={captureHeldRef}>
            {/* The only variable-width control here (its label follows the
                language name), so it's the one that goes under @md — leaving
                the row a fixed floor. It must stay laid out while its popup
                is open, though: Base UI anchors to the trigger, and a
                display:none trigger positions the popup at 0,0.
                `empty:hidden` keeps the row's gap off an extensionless file,
                where the picker renders nothing. */}
            <span
              ref={langWrapRef}
              className="hidden @md/diff-pane:flex empty:hidden has-[[data-popup-open]]:flex"
            >
              <DiffLanguagePicker
                filePath={filePath}
                open={langOpen}
                onOpenChange={(open) => {
                  setLangOpen(open);
                  if (!open) returnFocusIfTriggerHidden();
                }}
              />
            </span>
            {whitespaceControl && (
              <DiffViewOptionsMenu onToggle={flipWhitespace} />
            )}
            <DiffModeToggle splitDisabled={narrowPane} />
          </span>
        )}
      </DiffPathRow>
      {body}
    </div>
  );
  // Every arm but the text, image and typechange ones is a focus landing for a
  // toolbar swap: its body, a sibling of the row, never an ancestor of a
  // scroller (it would take every click into it, so those arms' bodies aren't
  // one). Each arm's body is keyed apart, since the text body reusing this node
  // would drop its tabIndex under held focus. `busy` marks a blank, loading body.
  const landing = (content: ReactNode, busy = false) => (
    <div
      key="arm-landing"
      ref={armRef}
      tabIndex={-1}
      aria-busy={busy || undefined}
      className="min-h-0 flex-1 outline-none"
    >
      {content}
    </div>
  );

  // Diffs load near-instantly from local git, so a skeleton only adds a flash
  // and a layout shift on the way to the real content: the body stays blank
  // under the path row until it's ready. A read parked offline would stay
  // blank forever, so it says why instead.
  if (isPending) {
    return shell(
      isPaused
        ? landing(
            <DiffPlaceholder message={offlinePendingMessage("this diff")} />,
          )
        : landing(null, true),
    );
  }
  // Every backend diff command echoes the requested path back verbatim, so a
  // mismatch means `data` is a stale placeholder from the previously selected
  // file's key. Re-scope this if the backend ever normalizes the path it returns.
  if (data && data.filePath !== filePath) return shell(landing(null, true));
  // Only a failure with nothing to show replaces the body: react-query keeps the
  // last good diff beside `isError`, and that stays up under a notice.
  if (!data) {
    return shell(
      landing(<DiffPlaceholder message="Could not load diff for this file" />),
    );
  }
  // The old side's whole-file reads follow the diff's own pairing. A placeholder
  // never lends its `oldPath`: it is another key's diff (another commit's, for
  // the same path), while the revs already name the new selection.
  const oldSidePath = dataIsPlaceholder ? filePath : (data.oldPath ?? filePath);

  // Error + fetching (a reconnect's resumed read) is unsettled: no notice. A
  // settled error says it failed, with Retry; a park (alone, or over an error)
  // says offline, without one. The gate and the copy key on the same two arms,
  // so an unsettled error can never fall through to the offline sentence.
  const failed = refreshFailed({ isError, isPaused, isFetching });
  const notice = (
    <DegradedListNotice
      noun="this diff"
      degraded={failed || isPaused}
      message={detailNoticeMessage({
        noun: "diff",
        isError: failed,
        stale: dataIsPlaceholder ?? false,
      })}
      onRetry={failed ? onRetry : undefined}
      className="shrink-0 border-b py-1.5"
    />
  );
  // The binary, image, empty and header-only arms draw retained data too, so
  // they carry the same notice as the text diff.
  if (data.isBinary) {
    if (repoPath && imageRevs && imageMime(filePath)) {
      return shell(
        <div key="arm-image" className="min-h-0 flex-1">
          <ImageDiff
            repoPath={repoPath}
            filePath={filePath}
            oldPath={oldSidePath}
            revs={imageRevs}
          />
        </div>,
        notice,
      );
    }
    // A file↔symlink typechange with one binary half stacks both halves in
    // git's order. The text half is read-only: hosts that group a binary
    // pane's comments outside it would render an inline anchor twice.
    const halves = typechangeHalves(data.text, filePath);
    if (halves !== null) {
      const band = (
        <div
          key="band"
          className={cn(
            "flex flex-col items-center gap-1 py-3 text-muted-foreground",
            halves.binaryFirst ? "border-b" : "border-t",
          )}
        >
          <p className="flex items-center gap-1.5 text-xs">
            <FileIcon aria-hidden className="size-4" />
            {TYPECHANGE_BAND_LABEL[halves.binaryEnd]}
          </p>
          {repoPath !== undefined ? (
            <BinaryFileSummary
              repoPath={repoPath}
              filePath={filePath}
              text={data.text}
              worktreeNewSide={imageRevs?.new === null}
              anchorCommit={anchorCommit}
              held={dataIsPlaceholder === true}
              variant="band"
            />
          ) : null}
        </div>
      );
      const textHalf = (
        <GitDiffView
          key="text"
          filePath={filePath}
          oldPath={filePath}
          text={halves.text}
          repoPath={repoPath}
          forceUnified={narrowPane}
          revealLanding={controlsRef}
          scrollerRef={scrollerRef}
        />
      );
      return shell(
        <div
          key="arm-typechange"
          ref={scrollerCaptureRef}
          className="min-h-0 flex-1 overflow-auto"
        >
          {halves.binaryFirst ? [band, textHalf] : [textHalf, band]}
        </div>,
        notice,
      );
    }
    return shell(
      landing(
        <DiffPlaceholder
          message="Binary file — no text diff available"
          action={
            repoPath !== undefined ? (
              <BinaryFileSummary
                repoPath={repoPath}
                filePath={filePath}
                text={data.text}
                worktreeNewSide={imageRevs?.new === null}
                anchorCommit={anchorCommit}
                held={dataIsPlaceholder === true}
              />
            ) : undefined
          }
        />,
      ),
      notice,
    );
  }
  // Ahead of the empty and header-only arms, which under `-w` would say nothing
  // changed. The button lands focus on this body first, since a host with no
  // placeholder blanks the pane for the reload.
  if (whitespaceOnly) {
    const modeLine =
      headerOnly?.kind === "mode" ? modeChangeMessage(headerOnly) : null;
    return shell(
      landing(
        <DiffPlaceholder
          message={WHITESPACE_ONLY_MESSAGE}
          action={
            <div className="flex flex-col items-center gap-2">
              {headerOnly !== null && <HeaderOnlyDetail diff={headerOnly} />}
              {modeLine !== null && <p className="text-xs">{modeLine}</p>}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  armLandingRef.current?.focus({ preventScroll: true });
                  flipWhitespace(false);
                }}
              >
                {SHOW_WHITESPACE_LABEL}
              </Button>
            </div>
          }
        />,
      ),
      notice,
    );
  }
  if (emptyDiff) {
    // An untracked empty file's --no-index diff is header-only, which the arm
    // below names; an empty answer for one still never reads as unchanged.
    return shell(
      landing(
        <DiffPlaceholder
          message={
            stagingSide === "untracked"
              ? headerOnlyMessage({ kind: "new-empty" })
              : "No changes to show"
          }
        />,
      ),
      notice,
    );
  }
  // Ahead of the preview arms, so a new empty Markdown file never opens Preview.
  if (headerOnly !== null) {
    return shell(
      landing(
        <DiffPlaceholder
          message={headerOnlyMessage(headerOnly)}
          action={<HeaderOnlyDetail diff={headerOnly} />}
        />,
      ),
      notice,
    );
  }

  // SVGs are text, but they're also images: show the rendered old/new
  // comparison above the code diff when revisions are available.
  const svgPreview = Boolean(
    repoPath && imageRevs && filePath.toLowerCase().endsWith(".svg"),
  );

  return shell(
    <Fragment key="arm-text">
      {/* Not gated on Preview, unlike the truncated label: the whole-file
          staging rule holds whichever view is up. */}
      {stagingSide !== undefined && data.undecodable && (
        <InfoNote className="shrink-0">
          {UNDECODABLE_NOTE_COPY[stagingSide]}
        </InfoNote>
      )}
      <div ref={scrollerCaptureRef} className="min-h-0 flex-1 overflow-auto">
        {previewOn && repoPath && previewRevs ? (
          // Passed the raw revs, not the truncation-stripped pair below:
          // preview reads the file, not the diff, so it works on exactly the
          // truncated diffs content mode gives up on. Its own capture node,
          // since the scroller persists when only Preview leaves.
          <span className="contents" ref={captureHeldRef}>
            <MarkdownDocPreview
              repoPath={repoPath}
              filePath={filePath}
              oldPath={oldSidePath}
              revs={previewRevs}
            />
          </span>
        ) : (
          <>
            {svgPreview && repoPath && imageRevs && (
              <div className="border-b">
                <ImagePanes
                  repoPath={repoPath}
                  filePath={filePath}
                  oldPath={oldSidePath}
                  revs={imageRevs}
                />
              </div>
            )}
            <GitDiffView
              filePath={filePath}
              oldPath={oldSidePath}
              text={data.text}
              repoPath={repoPath}
              // A truncated diff was cut by the byte cap and can't line up
              // with the full file text, and a placeholder one belongs to the
              // previous selection while the revs already name the new — neither
              // pairing can be whole-file highlighted.
              contentRevs={
                data.isTruncated || dataIsPlaceholder ? undefined : contentRevs
              }
              lineAnchors={lineAnchors}
              lineWidget={lineWidget}
              forceUnified={narrowPane}
              revealLanding={controlsRef}
              scrollerRef={scrollerRef}
            />
          </>
        )}
      </div>
    </Fragment>,
    notice,
  );
}

const TYPECHANGE_BAND_LABEL: Record<TypechangeHalves["binaryEnd"], string> = {
  added: "Binary file added",
  removed: "Binary file removed",
};

/** A rename or copy's two ends under its header-only message (the path row
 *  above names only the file, and shows no controls here), and the mode
 *  change when one rides along. Nothing for the other kinds. */
function HeaderOnlyDetail({ diff }: { diff: HeaderOnlyDiff }) {
  if (diff.kind !== "rename" && diff.kind !== "copy") return null;
  const mode = modeChangeMessage(diff);
  return (
    <div className="flex w-full max-w-md min-w-0 flex-col items-center gap-1 px-4 text-xs">
      {diff.oldPath !== undefined && (
        <HeaderOnlyPathRow label="From" path={diff.oldPath} />
      )}
      {diff.newPath !== undefined && (
        <HeaderOnlyPathRow label="To" path={diff.newPath} />
      )}
      {mode !== null && <p>{mode}</p>}
    </div>
  );
}

function HeaderOnlyPathRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex max-w-full min-w-0 gap-1.5">
      <span className="shrink-0">{label}</span>
      <PathText path={path} className="font-mono" />
    </div>
  );
}
