import {
  DiffFile,
  DiffModeEnum,
  DiffView,
  DiffViewWithMultiSelect,
  type DiffViewWithMultiSelectRef,
  type LineRange,
  type MultiSelectResult,
  type MultiSelectState,
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
import { capDiffText, DIFF_LINE_CAP } from "./cap-diff";
import { DiffErrorBoundary } from "./DiffErrorBoundary";
import { DiffLanguagePicker } from "./DiffLanguagePicker";
import { DiffPlaceholder } from "./DiffPlaceholder";
import { diffLang } from "./diff-lang";
import { ImageDiff, ImagePanes, type ImageRevs, imageMime } from "./ImageDiff";
import {
  ensureBuiltinShikiLang,
  ensureShikiGrammars,
  isBuiltinShikiLang,
  isShikiLang,
  shikiDiffHighlighter,
} from "./shiki-highlighter";
import { ensureCustomLanguages } from "./syntax";

/**
 * A line-anchored annotation rendered under a specific diff line (e.g. a PR
 * review thread). The library renders it as an always-visible block below the
 * anchored line, in both Unified and Split modes.
 *
 * `extendData` holds ONE entry per line per side — duplicates silently
 * last-write-win — so callers must pre-group multiple anchors on the same
 * side+line into a single `render()` that stacks them (as PrFilesPane does).
 * Anchors on lines beyond the large-diff cap don't render until the user
 * expands "Show full diff".
 */
export interface DiffLineAnchor {
  side: "old" | "new";
  /** 1-based line number in that side's file. */
  line: number;
  render: () => ReactNode;
}

/**
 * An inline composer widget opened from a diff line: click a line number (or
 * drag-select a range on the gutter) to open a slot BELOW that line, rendered by
 * `render` with the resolved anchor. Generic so any surface (PR review today,
 * commit comments later) can reuse it. When absent, the diff renders exactly as
 * before — the plain vendored `<DiffView>`, no clickable line numbers, no
 * range-select wrapper (a hard zero-diff requirement, since this component backs
 * history/working-tree/PR diffs).
 *
 * `render` receives the anchored `line` (the END line of a range) and `fromLine`
 * (the range start, equal to `line` for a single line), the resolved `side`, and
 * an `onClose` that dismisses the slot.
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
 * whole-file comment/string context (a hunk that starts mid-block-comment would
 * otherwise mis-color the code after it). `null` = working tree; omit a side
 * (undefined) when it has no version there (e.g. an added file's old side). The
 * pair MUST match the diff command's own old/new, or tokens map onto the wrong
 * lines. See the diff-highlight-midcomment task.
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
 * The highest old- and new-side line numbers a unified diff's hunk headers
 * reference. Content mode maps syntax onto the diff *by line number*, so each
 * side's read-back file must reach these lines; if a cached content read has
 * gone stale and is shorter than the diff (e.g. `:0` was cached when the staged
 * file was smaller, then it grew), the renderer highlights only the lines the
 * stale content covers and leaves the rest plain. {@link useFileContent} uses
 * this to fall back to the self-consistent hunk-only path instead.
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

// Past this size, syntax highlighting (synchronous highlight.js) blocks long
// enough to hurt; render the still-diff-colored plain view instead.
const HIGHLIGHT_MAX_CHARS = 100_000;
// Cap on the whole-file content read for content mode's highlight context: past
// this many lines a file isn't read in full (the hunk-only path is used), and
// useFileContent's budget check uses it too. Set to highlight.js's own line
// threshold so any file small enough to read in full is also one it'll highlight.
export const HIGHLIGHT_MAX_LINES = 2000;

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
    // Built-in Shiki grammars load lazily (RenderedDiff kicks that off), so this
    // synchronous build can only route to Shiki once the grammar is already
    // loaded. Until then a built-in Shiki language falls back to highlight.js /
    // plain; RenderedDiff rebuilds the diff when the grammar finishes loading.
    const useShiki = lang ? isShikiLang(lang) : false;
    const file = DiffFile.createInstance({
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
    });
    file.initRaw();
    // Highlighting is cheap (<10ms even here); the real cost is the DiffView
    // render, so build the diff in a single pass — skipping highlight only for
    // files too big in chars to be worth it. The line-count cutoff is left to the
    // renderer's own per-engine `maxLineToIgnoreSyntax` (highlight.js 2000, our
    // Shiki highlighter 5000): gating here on one line count would wrongly skip
    // large Shiki-rendered files (e.g. Rust) the renderer would happily do.
    if (lang && text.length <= HIGHLIGHT_MAX_CHARS) {
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
 * Reads the full old/new file text for whole-file highlight context (the
 * content-mode path) and returns `{ content, pending }`: `content` is
 * `{old,new}` to hand {@link createDiffFile}, or `null` when content mode
 * shouldn't apply (no revs, unreadable side, or a diff too big in lines/chars
 * for the renderer to highlight). `pending` is true only while content mode
 * WANTS to apply but its whole-file reads haven't settled yet — callers gate on
 * it to avoid painting an intermediate hunk-only diff that will immediately be
 * rebuilt into the collapsible content-mode layout once the reads land (the
 * "diff flash" single-paint fix). Gated to small, non-truncated diffs whose
 * files fit the highlight budget. The rev pair MUST match the diff's own
 * old/new. Shared by the read-only diff surface and the staging diff viewer.
 * `diffText`/`filePath` should already be deferred values.
 */
export function useFileContent(
  repoPath: string | undefined,
  filePath: string,
  diffText: string,
  contentRevs?: DiffContentRevs,
  // Max diff size before content mode (whole-file highlight + collapsible
  // expand) engages. The read-only surface caps its render at DIFF_LINE_CAP and
  // uses that default; the staging view renders every hunk regardless, so it
  // passes the larger highlight budget — a big diff in a normal-size file then
  // still highlights correctly instead of falling back to the hunk-only,
  // mid-comment-leaking path.
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
    s.length <= HIGHLIGHT_MAX_CHARS && countLines(s) <= HIGHLIGHT_MAX_LINES;
  // Content mode maps syntax onto the diff by line number, so each side's
  // read-back text must reach the highest line the diff references. A stale,
  // shorter read (e.g. `:0` cached before the staged file grew) would otherwise
  // highlight only its first lines and leave the rest plain — fall back to the
  // self-consistent hunk-only path instead.
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
  // Content mode wants to apply here but its whole-file reads are still in
  // flight — the caller should hold the paint rather than build a hunk-only diff
  // it will immediately restructure once the reads settle. An already-viewed
  // file settles instantly from the query cache (isPending, not isFetching, so a
  // background refetch of cached data never re-blanks the pane).
  const pending = wantContent && (!oldSettled || !newSettled);
  return useMemo(
    () => ({
      content: useContent ? { old: oldText, new: newText } : null,
      pending,
    }),
    [useContent, oldText, newText, pending],
  );
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

  // Whole-file highlight context + collapsible expand for small diffs; `content`
  // is null when it shouldn't apply (big file / unreadable / truncated → capped
  // hunk-only). `contentPending` is true while content mode wants to apply but
  // its reads are still loading — we hold the whole paint until it settles so the
  // diff is built ONCE (in its final content-mode layout) rather than painted
  // hunk-only first and rebuilt when the reads land (the visible "flash").
  const { content, pending: contentPending } = useFileContent(
    repoPath,
    deferredPath,
    deferredText,
    contentRevs,
  );

  const { shown, hidden } = useMemo(() => {
    // Content mode renders the full diff (the renderer collapses non-hunk
    // context into expandable gaps), so the cap doesn't apply there.
    if (content) return { shown: deferredText, hidden: 0 };
    const r = showFull
      ? { text: deferredText, hidden: 0 }
      : capDiffText(deferredText, DIFF_LINE_CAP);
    return { shown: r.text, hidden: r.hidden };
  }, [deferredText, showFull, content]);

  // Syntax prefs follow the active repo (repo-scoped custom languages); the
  // active repo owns every surface that supplies content, so this matches.
  const activeRepo = useUiStore((s) => s.repoPath);
  const { syntaxMap, customLanguages } = useEffectiveSyntax(activeRepo);

  // Built-in Shiki grammars (astro/tsx/rust &c.) load lazily to keep them off
  // the startup bundle. The first time a diff needs one it isn't loaded yet, so
  // rather than build the diff hunk-only-highlighted and rebuild it when the
  // grammar lands (the visible highlight pop-in), we hold the paint until the
  // load settles. Track each language's outcome ("ready" or "failed") so a
  // failed import still releases the gate — a missing grammar must fall back to
  // highlight.js / plain, never deadlock the pane.
  const [grammarState, setGrammarState] = useState<
    Record<string, "ready" | "failed">
  >({});
  const lang = useMemo(
    () => diffLang(deferredPath, syntaxMap),
    [deferredPath, syntaxMap],
  );
  useEffect(() => {
    if (
      !lang ||
      !isBuiltinShikiLang(lang) ||
      isShikiLang(lang) ||
      grammarState[lang] !== undefined
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
  }, [lang, grammarState]);

  // A built-in Shiki grammar this diff needs is still loading (never seen a
  // "ready"/"failed" result for it): hold the paint. `isShikiLang(lang)` already
  // true means it loaded (this or an earlier diff), so it isn't pending.
  const grammarPending =
    !!lang &&
    isBuiltinShikiLang(lang) &&
    !isShikiLang(lang) &&
    !grammarState[lang];

  // grammarState is a deliberate rebuild trigger: createDiffFile reads the
  // now-loaded Shiki grammar via module state (isShikiLang), not a passed value,
  // so recording the load result is what forces the rebuild that picks the
  // grammar up (the gate below only lets the first build run once it's settled).
  // biome-ignore lint/correctness/useExhaustiveDependencies: grammarState is an intentional rebuild trigger, read via module state not directly
  const diffFile = useMemo(
    () =>
      contentPending || grammarPending
        ? null
        : createDiffFile(
            deferredPath,
            shown,
            { syntaxMap, customLanguages },
            content ?? undefined,
          ),
    [
      shown,
      deferredPath,
      syntaxMap,
      customLanguages,
      content,
      contentPending,
      grammarPending,
      grammarState,
    ],
  );

  // Build the per-side extendData maps from the anchors (keyed by String(line)).
  // Memoized for referential stability: the vendored DiffView is store-based and
  // a fresh object each render would thrash it. Anchors on lines beyond the
  // large-diff cap simply don't render until "Show full diff" expands the diff.
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
  // The vendored DiffViewWithMultiSelect only honors a stored multi-select range
  // when the clicked "+" sits on the range's MAX line; a click on any other
  // selected line wipes the range and reports single-line (index.mjs ~1829-1871).
  // Its onSelectionComplete also only stores the range when `lines.length > 0`,
  // so an empty lines computation loses it entirely (~1733-1745). We therefore
  // track the last completed drag range ourselves and re-apply it in
  // renderWidgetLine so a click on ANY line of the range still opens the composer
  // as a range. All of this is scoped to the lineWidget-enabled branch below —
  // read-only surfaces render the plain <DiffView> and never touch this state.
  const multiSelectRef = useRef<DiffViewWithMultiSelectRef>(null);
  // The last completed (or in-flight, as a fallback) drag range. `dragRangeRef`
  // is set on onMultiSelectComplete; `changeRangeRef` mirrors the latest non-null
  // range seen while selecting, so the secondary empty-`lines` path still
  // captures it.
  const dragRangeRef = useRef<SideRange | null>(null);
  const changeRangeRef = useRef<SideRange | null>(null);
  // The range the CURRENTLY-OPEN overridden widget resolved to, tagged with the
  // exact reported anchor it opened at (`anchorSide`/`anchorLine` = the raw side
  // + reported line the library passed renderWidgetLine). Rule B reuses `range`
  // ONLY when a later call reports that SAME anchor — i.e. the same widget
  // re-rendering — so it stays a range across parent re-renders without
  // downgrading. A press on a DIFFERENT line reports a different anchor (the
  // library's single-widget store just replaces the open one WITHOUT calling our
  // onClose, react ~1192-1200/687), so it correctly falls through to fresh
  // resolution instead of inheriting this range. Also gates capture: while set, a
  // widget is open, so completion/change events are press-echo noise, not a real
  // drag. Cleared in the wrapped onClose.
  const activeOverrideRef = useRef<{
    anchorSide: "old" | "new";
    anchorLine: number;
    range: SideRange;
  } | null>(null);
  // The range the highlight is currently pinned to (or null), so an identical
  // re-assert no-ops instead of re-touching the DOM. The highlight is a purely
  // imperative call on the manager (setPreselectedLines mutates the DOM only, no
  // React state), so there is NO re-render on widget open — which is what kept
  // the composer from flashing (a state bump would recreate this inline
  // renderWidgetLine and thrash the memoized inner DiffView table).
  const preselectSigRef = useRef<string>("");
  // Re-apply the range highlight (the library wiped its own preselect on the "+"
  // press) or clear it on close/no-override. Deferred via a microtask so it never
  // runs DURING render — but it is a direct manager call, not routed through a
  // React commit. Guarded by a signature so a stable open widget re-asserting the
  // same range does nothing.
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
      // Capture EVERY completed drag — even while a widget is open. Do NOT gate
      // this on activeOverrideRef: a widget can be replaced/dismissed WITHOUT
      // our wrapped onClose ever firing (the library's single-widget store just
      // swaps it, react ~1192-1200/687), leaving activeOverrideRef set forever;
      // gating here would then silently starve every future drag → the "works
      // once, then stops" intermittency. There is no press-echo to guard against:
      // pressing "+" makes the wrapper call clearSelection, which resets
      // isSelecting, so the mouseup hits handleMouseUp with isSelecting=false →
      // resetState only, NO onSelectionComplete (core ~3603). So this only ever
      // fires for a real user drag. A stale override is instead retired in
      // resolveWidgetRange when a differently-anchored widget renders.
      dragRangeRef.current = normRange(result.range);
    },
    [normRange],
  );
  const onMultiSelectChange = useCallback(
    (range: LineRange | null, state: MultiSelectState) => {
      // NOTE: we deliberately do NOT clear dragRangeRef when a new selection
      // starts. Pressing the "+" button itself starts a native single-line
      // selection on mousedown (core handleMouseDown, before any React handler),
      // firing this with isSelecting:true — clearing here would wipe the very
      // range the press is trying to open. A completed drag's range must SURVIVE
      // the press restart. Staleness is instead handled by: a real new drag's
      // COMPLETE overwriting it, resolveWidgetRange dropping it on an
      // out-of-range click, and the wrapped onClose clearing it.
      //
      // Do NOT re-add an `if (activeOverrideRef.current) return` guard here (or
      // in onMultiSelectComplete): a widget can vanish without our onClose firing
      // (the library swaps its single widget in place), so gating on an override
      // that never clears would starve every subsequent real drag. The "+"-press
      // echo it was meant to suppress does not exist — the wrapper's
      // clearSelection resets isSelecting, so mouseup produces resetState only,
      // no onSelectionComplete. And the manager only ever fires onSelectionChange
      // with isSelecting:true (handleMouseDown / handleMouseOver), so there is no
      // selection-ended branch to promote/reset here — just mirror the latest
      // in-flight range so the empty-`lines` mouseup path (no
      // onMultiSelectComplete, react ~1736) still has a range to fall back to.
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
      // (B) The SAME open overridden widget re-rendering (identical reported
      // anchor) keeps its range, so a parent re-render after the captured drag
      // range moves on never downgrades an open composer to single-line. A press
      // on a different line reports a different anchor and falls through.
      const active = activeOverrideRef.current;
      if (
        active &&
        active.anchorSide === side &&
        active.anchorLine === reportedLine
      ) {
        return active.range;
      }
      // A genuinely new resolution starts here (the reported anchor differs from
      // any active override → the old widget is gone). Always REPLACE the ref
      // with this resolution's outcome so a dead widget's override never lingers:
      // the new override when a range fires, or null when it resolves single-line.
      // This is what retires the stale override that onMultiSelectComplete no
      // longer guards against.
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

  // Stable identity so a parent re-render (or a widget-open highlight sync) never
  // recreates this prop — the library memoizes its internal widget renderer on
  // [renderWidgetLine] (react ~1789-1804), so a fresh closure would re-render the
  // whole inner DiffView table right after the composer mounts → a visible flash.
  // Every helper it calls is itself a stable useCallback / module-level fn, so the
  // dep list is honest and stable.
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
      // Re-apply the range highlight the library wiped on the "+" press (or clear
      // it when there's no override). Imperative-only — no React state, no
      // re-render — deferred out of the render phase via a microtask.
      syncPreselect(overrode ? resolved : null);
      return (
        // The library's widget slot gives the row no background, so anchor the
        // composer onto its own opaque, elevated card (like the app's other
        // floating composers). The slot otherwise resets every descendant to
        // `color: initial` (→ black), which would flatten this content — but that
        // reset (and its extend-wrapper twin) is stripped at build time by a tiny
        // postcss plugin (see vite.config.ts), leaving natural inheritance intact.
        // So no color hammer is needed: the card's `text-popover-foreground` is
        // inherited by unstyled nodes and the composer's own color utilities keep
        // their semantic tones.
        //
        // The slot renders under the CLICKED line, not the range's end line — a
        // base-library limitation we accept; the composer's own "Lines X–Y" label
        // carries the true anchor.
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

  // Inputs still settling (whole-file reads or the lazy grammar): render nothing
  // rather than a hunk-only diff we'd immediately rebuild — the single-paint gate
  // that removes the flash. Must precede the empty-state placeholder so loading
  // never masquerades as "No changes to show". Matches DiffContent's own
  // render-nothing-while-loading design (see the comment there).
  if (contentPending || grammarPending) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  return (
    <>
      {lineWidget?.enabled ? (
        // Line-comment mode: the multi-select variant adds clickable line numbers
        // and drag-to-select-a-range, opening the composer widget below the line.
        // Only mounted when a caller opts in (PR Files tab) — every read-only
        // surface keeps the plain <DiffView> below, byte-for-byte unchanged.
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
          // Track the drag range ourselves so a "+" press on ANY line of the
          // range still opens a range composer. Necessary because the library's
          // own max-line fast path never fires: pressing "+" starts a native
          // single-line selection on mousedown (core handleMouseDown, an ancestor
          // native listener that runs BEFORE React's synthetic handlers), which
          // makes the wrapper wipe its stored multiResult (react ~1728-1730);
          // then the React onMouseDown opens the widget and calls the manager's
          // clearSelection, so the later mouseup fires no onSelectionComplete
          // (core handleMouseUp ~3603: isSelecting already false → resetState
          // only). The widget renders during the mousedown discrete-event flush,
          // BEFORE mouseup. Because we no longer clear dragRangeRef on
          // isSelecting-start, our captured drag range still holds at render
          // time → resolveWidgetRange overrides the single-line report → the
          // composer opens as "Lines X–Y".
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
      {hidden > 0 && (
        <div className="flex items-center justify-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}{" "}
            hidden for performance
          </span>
          <Button size="xs" variant="outline" onClick={() => setShowFull(true)}>
            Show full diff
          </Button>
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {filePath}
          {data.isTruncated && " (truncated — diff too large)"}
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
