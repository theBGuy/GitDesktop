import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { type ReactNode, useDeferredValue, useMemo, useState } from "react";
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
}: {
  filePath: string;
  text: string;
  /** The diff's own repo, for reading full file text (highlight context). */
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  /** Line-anchored annotations (e.g. PR review threads) rendered under a line. */
  lineAnchors?: DiffLineAnchor[];
}) {
  return (
    <DiffErrorBoundary resetKey={`${filePath} ${text.length}`}>
      <RenderedDiff
        filePath={filePath}
        text={text}
        repoPath={repoPath}
        contentRevs={contentRevs}
        lineAnchors={lineAnchors}
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
    const useShiki = lang
      ? (!!tmLang && isShikiLang(lang)) || ensureBuiltinShikiLang(lang)
      : false;
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
 * content-mode path) and returns `{old,new}` to hand {@link createDiffFile}, or
 * `null` when content mode shouldn't apply (no revs, unreadable side, or a diff
 * too big in lines/chars for the renderer to highlight). Gated to small,
 * non-truncated diffs whose files fit the highlight budget. The rev pair MUST
 * match the diff's own old/new. Shared by the read-only diff surface and the
 * staging diff viewer. `diffText`/`filePath` should already be deferred values.
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
): { old: string; new: string } | null {
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
  return useMemo(
    () => (useContent ? { old: oldText, new: newText } : null),
    [useContent, oldText, newText],
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
}: {
  filePath: string;
  text: string;
  repoPath?: string;
  contentRevs?: DiffContentRevs;
  lineAnchors?: DiffLineAnchor[];
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

  // Whole-file highlight context + collapsible expand for small diffs; null when
  // it shouldn't apply (big file / unreadable / truncated → capped hunk-only).
  const content = useFileContent(
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
  const diffFile = useMemo(
    () =>
      createDiffFile(
        deferredPath,
        shown,
        { syntaxMap, customLanguages },
        content ?? undefined,
      ),
    [shown, deferredPath, syntaxMap, customLanguages, content],
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

  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  return (
    <>
      <DiffView<{ render: () => ReactNode }>
        diffFile={diffFile}
        diffViewMode={
          viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified
        }
        diffViewTheme={isDark ? "dark" : "light"}
        diffViewHighlight
        diffViewWrap
        diffViewFontSize={12}
        extendData={extendData}
        // A card renders inside the diff table; give it a neutral, non-mono
        // container so it doesn't inherit the code cell's font/background.
        renderExtendLine={
          extendData
            ? ({ data }) => (
                <div className="border-y bg-background px-3 py-2 font-sans text-xs">
                  {data.render()}
                </div>
              )
            : undefined
        }
      />
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
}: {
  filePath: string;
  diff: UseQueryResult<FileDiff>;
  repoPath?: string;
  imageRevs?: ImageRevs;
  contentRevs?: DiffContentRevs;
  lineAnchors?: DiffLineAnchor[];
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
        />
      </div>
    </div>
  );
}
