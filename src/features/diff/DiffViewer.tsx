import {
  createDiffMultiSelectManager,
  DiffModeEnum,
  DiffView,
} from "@git-diff-view/react";
import { InfoIcon } from "@phosphor-icons/react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import type { SelectedLine } from "@/lib/git/api";
import {
  buildHunkPatch,
  type DiffHunk,
  type ParsedDiff,
  parseHunks,
} from "@/lib/git/hunks";
import {
  useApplyPartial,
  useApplyPatch,
  useDiscardUntrackedLines,
  useFileDiff,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  bindingToAriaKeyshortcuts,
  formatBinding,
  isMac,
} from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import type { SelectedFile } from "@/lib/stores/ui";
import { useUiStore } from "@/lib/stores/ui";
import { useEffectiveSyntax } from "@/lib/syntax/queries";
import { toastError } from "@/lib/toast";
import { useContainerWidth } from "@/lib/use-container-width";
import { useIsDark } from "@/lib/use-is-dark";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import {
  DIFF_MAX_LINE_CHARS,
  DIFF_MEGA_LINE_CHARS,
  longestLineLength,
  shortenLongLines,
} from "./cap-diff";
import { DiffLanguagePicker } from "./DiffLanguagePicker";
import { DiffPlaceholder } from "./DiffPlaceholder";
import {
  createDiffFile,
  type DiffContentRevs,
  DiffModeToggle,
  DiffSurface,
  HIGHLIGHT_MAX_LINES,
  useFileContent,
  useShikiRouting,
} from "./DiffSurface";
import { fileExt } from "./diff-lang";
import { ImagePanes } from "./ImageDiff";
import {
  type MarkdownDiffView,
  MarkdownDocPreview,
  MarkdownViewToggle,
} from "./MarkdownPreview";
import { isMarkdownPath } from "./markdown-preview";
import { SPLIT_MIN_CONTAINER_PX } from "./split-threshold";
import { useHiddenTriggerFocus } from "./use-hidden-trigger-focus";

/** Working-tree diff for the file selected in the changes panel. */
export function DiffViewer({ repoPath }: { repoPath: string }) {
  const selectedFile = useUiStore((s) => s.selectedFile);
  // Shared cache with the changes list — used only to tell "clean tree" apart
  // from "files exist but none picked yet" so the empty pane reads honestly.
  const status = useRepoStatus(repoPath);
  const resolveActive = useConflictResolve((s) => s.activePath);
  const resolveScope = useConflictResolve((s) => s.scopePath);
  // A walk armed in a PR takeover's hidden worktree names files by ITS paths — a
  // same-named conflict here is a different file, so only this tree's walk counts.
  const resolveHere = resolveScope === repoPath ? resolveActive : null;
  // Render off a deferred selection so rapidly arrowing the changes list only
  // mounts + loads the file landed on (the row keeps WorkingTreeDiff keyed, so
  // it remounts per file). The list highlight still uses the live selection.
  const deferredFile = useDeferredValue(selectedFile);

  if (!deferredFile) {
    const treeClean =
      !status.isPending && (status.data?.entries.length ?? 0) === 0;
    return (
      <DiffPlaceholder
        message={
          treeClean
            ? "No changes to review"
            : "Select a file to see its changes"
        }
      />
    );
  }

  // A conflicted file (unmerged index) gets the conflict editor instead of a
  // diff (a combined diff git can't render): per-region + whole-file resolution,
  // or the AI streaming view while a session is active for it. Conflicts always
  // live on the unstaged side.
  const liveEntry = status.data?.entries.find(
    (e) => e.path === deferredFile.path,
  );
  const isConflicted =
    liveEntry?.unstaged === "conflicted" || liveEntry?.staged === "conflicted";

  if (isConflicted) {
    return resolveHere === deferredFile.path ? (
      <ConflictResolveView
        key={deferredFile.path}
        repoPath={repoPath}
        path={deferredFile.path}
      />
    ) : (
      <ConflictFileView
        key={deferredFile.path}
        repoPath={repoPath}
        path={deferredFile.path}
      />
    );
  }

  return (
    <WorkingTreeDiff
      key={`${repoPath}:${deferredFile.staged}:${deferredFile.path}`}
      repoPath={repoPath}
      file={deferredFile}
    />
  );
}

/**
 * The working-tree variant of the diff pane: hunks render as cards with
 * whole-hunk stage/unstage/discard, plus drag-to-select for staging a subset of
 * lines. Binary, truncated, and generated/minified (one enormous line) diffs
 * fall back to the plain whole-file surface (which is what shows the
 * generated/minified placeholder); untracked text files stage here like any other.
 */
function WorkingTreeDiff({
  repoPath,
  file,
}: {
  repoPath: string;
  file: SelectedFile;
}) {
  const status = useRepoStatus(repoPath);
  // `untracked` must follow LIVE status, not the click-time snapshot: once some
  // lines of a new file are staged it becomes a tracked `AM` file, and the
  // unstaged side must switch from the `git diff --no-index` "everything is new"
  // view to a normal diff of the remaining (unstaged) lines. The staged side is
  // never untracked.
  const liveEntry = status.data?.entries.find((e) => e.path === file.path);
  const untracked =
    !file.staged &&
    (liveEntry ? liveEntry.unstaged === "untracked" : file.untracked);
  const diff = useFileDiff(repoPath, { ...file, untracked });
  const applyPatch = useApplyPatch(repoPath);
  const applyPartial = useApplyPartial(repoPath);
  const discardUntracked = useDiscardUntrackedLines(repoPath);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const isDark = useIsDark();
  // Split needs a legible column count per side; under it this pane renders
  // unified without ever writing the preference back (`null` = not yet
  // measured, which stays on the preference so the first paint doesn't flash).
  const [paneRef, paneWidth] = useContainerWidth<HTMLDivElement>();
  const narrowPane = paneWidth !== null && paneWidth < SPLIT_MIN_CONTAINER_PX;
  const viewMode = narrowPane
    ? "unified"
    : (settings.data?.diffViewMode ?? "unified");
  const [discard, setDiscard] = useState<{
    label: string;
    run: () => void;
    // A new (untracked) file has no committed version to revert to — the
    // confirm wording changes from "revert to last committed" to "remove".
    newFile?: boolean;
    // The diff text the confirm's `run` was built against — see the close
    // effect below.
    forText: string;
  } | null>(null);
  // Declared with the hooks above the `!hunkMode` early return below.
  const shownDiscard = useRetained(discard);
  // The drag-selected lines to stage/unstage/discard — file-wide, since the
  // single whole-file view lets a selection span multiple hunks.
  const [selectionState, setSelectionState] = useState<{
    lines: SelectedLine[];
    forText: string;
  } | null>(null);
  const clearSelection = useCallback(() => setSelectionState(null), []);
  // Owned here so the palette action can open the picker: this toolbar folds
  // the trigger under @md like the read-only surface does, so below that width
  // the action is the only route to it.
  const [langOpen, setLangOpen] = useState(false);
  // Raw ⇄ Preview for markdown/MDX. Never persisted, and this component is
  // keyed per file, so every file opens on Raw.
  const [mdView, setMdView] = useState<MarkdownDiffView>("raw");
  const {
    wrapRef: langWrapRef,
    controlsRef,
    returnFocusIfTriggerHidden,
  } = useHiddenTriggerFocus();
  // `parsed`, `hunkMode`, and `busy` are computed above the `!hunkMode` early
  // return because the hotkey registrations below run unconditionally and read
  // them.
  const busy =
    applyPatch.isPending ||
    applyPartial.isPending ||
    discardUntracked.isPending;
  const selectionBinding =
    useEffectiveBindings().get("stage-selected-lines") ?? null;

  const parsed: ParsedDiff | null = useMemo(() => {
    const data = diff.data;
    // A generated/minified file (one enormous line) would freeze the
    // un-virtualized staging renderer — route it down the whole-file
    // DiffSurface fallback, which shows the generated/minified placeholder.
    if (
      !data ||
      data.isBinary ||
      data.isTruncated ||
      longestLineLength(data.text) > DIFF_MEGA_LINE_CHARS
    )
      return null;
    return parseHunks(data.text);
  }, [diff.data]);

  // A truncated parse could cut a hunk in half — never offer to apply one.
  // Untracked text files line-stage too: `git apply --cached` of a subset of a
  // new-file patch creates the index entry directly (no intent-to-add needed),
  // so part of a new file can be committed. Binary/huge untracked files have
  // `parsed === null` and still fall through to the whole-file view below.
  const hunkMode = parsed !== null && parsed.hunks.length > 0;
  // A selection is valid only against the diff text it was dragged against —
  // stale by text means every consumer sees no selection at the same instant.
  const selection =
    selectionState !== null && selectionState.forText === diff.data?.text
      ? selectionState.lines
      : null;
  // Preview swaps the staging view out entirely, so the selection actions and
  // the toggle can never be on screen together (the selection arm owns the
  // whole cluster while a drag selection exists).
  const canPreview = hunkMode && isMarkdownPath(file.path);
  const previewOn = canPreview && mdView === "preview";
  // One contextual chord: stage the selection on an unstaged file's diff,
  // unstage it on a staged one — mirroring the toolbar's primary button. Dead
  // while the Discard confirm is open (the global listener has no dialog guard)
  // and while the non-staging fallback renders.
  useHotkeyAction(
    "stage-selected-lines",
    () => applySelection({ cached: true, reverse: file.staged }),
    hunkMode && selection !== null && !busy && discard === null,
  );
  useHotkeyAction(
    "clear-line-selection",
    clearSelection,
    hunkMode && selection !== null && !busy && discard === null,
  );
  // Only this toolbar's own arm registers: outside hunk mode the fallback
  // DiffSurface below renders the picker and registers for itself, and a child's
  // effect runs first — so an ungated registration here would win the dispatch
  // (newest handler) and open a toolbar that isn't on screen. The selection arm
  // replaces the picker with its stage/discard buttons, hence `selection`.
  useHotkeyAction(
    "change-diff-language",
    () => setLangOpen(true),
    // In Preview the picker isn't mounted, so the action would open nothing.
    hunkMode && selection === null && !previewOn && Boolean(fileExt(file.path)),
  );
  // Inert while a selection or the Discard confirm is up — the selection arm
  // owns the cluster, and the global listener has no dialog guard.
  useHotkeyAction(
    "toggle-markdown-preview",
    () => setMdView((v) => (v === "raw" ? "preview" : "raw")),
    canPreview && selection === null && discard === null,
  );
  // Any Discard confirm's `run` captured line numbers (or a hunk) at open
  // time — close it the moment the diff text moves on from the text it was
  // opened against (a refetch while the dialog is up), whichever arm opened it.
  const liveText = diff.data?.text;
  useEffect(() => {
    if (discard !== null && discard.forText !== liveText) setDiscard(null);
  }, [discard, liveText]);

  if (!hunkMode) {
    return (
      <DiffSurface
        filePath={file.path}
        diff={diff}
        repoPath={repoPath}
        // staged view compares HEAD → index; unstaged compares HEAD → worktree
        imageRevs={
          file.staged ? { old: "HEAD", new: ":0" } : { old: "HEAD", new: null }
        }
        // Full-text highlight context, aligned to the diff's actual sides:
        // staged = HEAD↔index, unstaged = index↔worktree, added = worktree only.
        contentRevs={
          untracked
            ? { newRev: null }
            : file.staged
              ? { oldRev: "HEAD", newRev: ":0" }
              : { oldRev: ":0", newRev: null }
        }
      />
    );
  }

  const onError = (e: unknown) => toastError(e);
  // Shortcut hints on the selection action: `aria-keyshortcuts` keeps the chord
  // off the accessible name, the title makes it discoverable. Both omitted when
  // the action is unbound.
  const selectionActionLabel = file.staged ? "Unstage" : "Stage";
  const selectionTitle =
    selectionBinding === null
      ? undefined
      : `${selectionActionLabel} (${formatBinding(selectionBinding)})`;
  const selectionKeyshortcuts =
    selectionBinding === null
      ? undefined
      : bindingToAriaKeyshortcuts(selectionBinding);
  // One source for the count: the visible copy can be truncated by a narrow
  // pane, and the announcement must carry the full text regardless.
  const selectionCountText =
    selection === null
      ? ""
      : `${selection.length} ${selection.length === 1 ? "line" : "lines"} selected`;

  function applyHunk(
    hunk: DiffHunk,
    opts: { cached: boolean; reverse: boolean },
  ) {
    if (!parsed) return;
    applyPatch.mutate(
      { patch: buildHunkPatch(parsed, hunk), ...opts },
      { onError, onSuccess: clearSelection },
    );
  }

  // Stage/unstage/discard the file-wide line selection. `build_partial_patch`
  // already distributes a multi-hunk selection, so hand it the WHOLE diff.
  function applySelection(opts: { cached: boolean; reverse: boolean }) {
    if (!selection || !diff.data) return;
    applyPartial.mutate(
      { diffText: diff.data.text, selected: selection, ...opts },
      { onError, onSuccess: clearSelection },
    );
  }

  // Discard lines from an untracked (new) file: remove just those new-side line
  // numbers from the file. A new file is all additions, so there's nothing to
  // reverse-apply (reverse-applying its patch would delete the whole file).
  function discardLines(lines: number[]) {
    if (lines.length === 0) return;
    discardUntracked.mutate(
      { path: file.path, lines },
      { onError, onSuccess: clearSelection },
    );
  }

  // Full-text revs aligned to the diff's actual sides: staged = HEAD↔index,
  // unstaged = index↔worktree, added = worktree only. One pair feeds both the
  // staging view's highlight context and the markdown preview.
  const workingRevs: DiffContentRevs = untracked
    ? { newRev: null }
    : file.staged
      ? { oldRev: "HEAD", newRev: ":0" }
      : { oldRev: ":0", newRev: null };

  // A whole-hunk action, fired by the per-hunk overlay buttons.
  function onHunkAction(hunk: DiffHunk, kind: "stage" | "unstage" | "discard") {
    if (kind === "discard") {
      setDiscard({
        label: hunk.header,
        newFile: untracked,
        forText: diff.data?.text ?? "",
        run: untracked
          ? () => discardLines(hunkAddedNewLines(hunk))
          : () => applyHunk(hunk, { cached: false, reverse: true }),
      });
    } else {
      applyHunk(hunk, { cached: true, reverse: kind === "unstage" });
    }
  }

  return (
    <div ref={paneRef} className="@container/staging-pane flex h-full flex-col">
      {/* The selection actions take over this row rather than opening one of
          their own: a row that mounts below the toolbar pushes the whole diff
          down on mouseup, moving the lines the user just dragged across. */}
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b px-3 py-1.5",
          // Full-width tint marks selection mode; the count text carries the
          // same state in words, so the cue is never colour alone.
          selection && "bg-primary/10",
        )}
      >
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          title={file.path}
        >
          {file.path}
        </span>
        {/* min-h-7 pins the cluster to the language picker's h-7 trigger: the
            xs (h-6) selection buttons — and an extensionless file, where the
            picker renders nothing — would otherwise shrink the row by 4px.
            The selection arm drops shrink-0 so a narrow pane takes width from
            the count (which truncates) instead of overflowing the row; every
            Button is shrink-0 by default, so the actions are the floor and
            can never be squeezed or clipped. tabIndex/outline-none make this a
            silent landing spot for focus when the picker closes with its
            trigger already hidden. */}
        <span
          ref={controlsRef}
          tabIndex={-1}
          className={cn(
            "flex min-h-7 items-center gap-1.5 outline-none",
            selection === null && "shrink-0",
          )}
        >
          {selection ? (
            <>
              <span
                className="min-w-0 truncate font-medium text-[11px]"
                title={selectionCountText}
              >
                {selectionCountText}
              </span>
              {file.staged ? (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  title={selectionTitle}
                  aria-keyshortcuts={selectionKeyshortcuts}
                  onClick={() =>
                    applySelection({ cached: true, reverse: true })
                  }
                >
                  Unstage
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    title={selectionTitle}
                    aria-keyshortcuts={selectionKeyshortcuts}
                    onClick={() =>
                      applySelection({ cached: true, reverse: false })
                    }
                  >
                    Stage
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() =>
                      setDiscard({
                        label: `${selection.length} selected ${selection.length === 1 ? "line" : "lines"}`,
                        newFile: untracked,
                        forText: diff.data?.text ?? "",
                        run: untracked
                          ? () =>
                              discardLines(
                                selection
                                  .filter((s) => s.side === "new")
                                  .map((s) => s.line),
                              )
                          : () =>
                              applySelection({ cached: false, reverse: true }),
                      })
                    }
                  >
                    Discard…
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={clearSelection}
              >
                Clear
              </Button>
            </>
          ) : (
            <>
              {canPreview && (
                <MarkdownViewToggle view={mdView} onChange={setMdView} />
              )}
              {/* The picker and Unified/Split configure the raw diff, so they
                  leave the cluster while Preview is up — the same swap this
                  row already does for the selection actions. */}
              {!previewOn && (
                <>
                  {/* Same treatment as the read-only surface's toolbar: the
                      picker is this row's only variable-width control (its
                      label follows the language name), so it goes under @md to
                      give the row a fixed floor — but stays laid out while its
                      popup is open, since Base UI anchors to the trigger and a
                      display:none trigger positions the popup at 0,0.
                      `empty:hidden` keeps the row's gap off an extensionless
                      file. */}
                  <span
                    ref={langWrapRef}
                    className="hidden @md/staging-pane:flex empty:hidden has-[[data-popup-open]]:flex"
                  >
                    <DiffLanguagePicker
                      filePath={file.path}
                      open={langOpen}
                      onOpenChange={(open) => {
                        setLangOpen(open);
                        if (!open) returnFocusIfTriggerHidden();
                      }}
                    />
                  </span>
                  <DiffModeToggle splitDisabled={narrowPane} />
                </>
              )}
            </>
          )}
        </span>
      </div>
      {/* Mounted unconditionally so the count announces as a live update; the
          visible count above is deliberately not the live region, which would
          announce the same text twice. */}
      <span role="status" aria-live="polite" className="sr-only">
        {selectionCountText}
      </span>
      <div className="ph-no-capture min-h-0 flex-1 overflow-auto">
        {file.path.toLowerCase().endsWith(".svg") && (
          <div className="border-b">
            <ImagePanes
              repoPath={repoPath}
              filePath={file.path}
              revs={
                file.staged
                  ? { old: "HEAD", new: ":0" }
                  : { old: "HEAD", new: null }
              }
            />
          </div>
        )}
        {previewOn ? (
          <MarkdownDocPreview
            repoPath={repoPath}
            filePath={file.path}
            revs={workingRevs}
          />
        ) : (
          <>
            {/* The drag-the-line-numbers hint is about the staging gutter, so
                it stays out of Preview, which has no line numbers at all. */}
            {(settings.data?.showLineStageHint ?? true) && (
              <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                <InfoIcon className="size-3.5 shrink-0" />
                <span className="flex-1 leading-snug">
                  Drag across the line numbers to{" "}
                  {file.staged ? "unstage" : "stage"} just those lines. Hold{" "}
                  {ADDITIVE_MODIFIER} while dragging to add to the selection, so
                  one selection can mix added and removed lines.
                  {selectionBinding !== null && (
                    <>
                      {" "}
                      Press {formatBinding(selectionBinding)} to{" "}
                      {file.staged ? "unstage" : "stage"} the selection.
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    settings.data &&
                    saveSettings.mutate({
                      ...settings.data,
                      showLineStageHint: false,
                    })
                  }
                  className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2 hover:no-underline"
                >
                  Don't show again
                </button>
              </div>
            )}
            <StagingDiffView
              repoPath={repoPath}
              filePath={file.path}
              diffText={diff.data?.text ?? ""}
              contentRevs={workingRevs}
              viewMode={viewMode}
              isDark={isDark}
              hunks={parsed.hunks}
              staged={file.staged}
              busy={busy}
              selection={selection}
              onSelect={(lines, forText) =>
                setSelectionState(lines === null ? null : { lines, forText })
              }
              onHunkAction={onHunkAction}
            />
          </>
        )}
      </div>

      <Dialog
        open={discard !== null}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {shownDiscard?.newFile ? (
                <>
                  Removes{" "}
                  <span className="font-mono">{shownDiscard?.label}</span> from{" "}
                  {file.path}. This cannot be undone.
                </>
              ) : (
                <>
                  Reverts{" "}
                  <span className="font-mono">{shownDiscard?.label}</span> in{" "}
                  {file.path} to the last committed version. This cannot be
                  undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscard(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                discard?.run();
                setDiscard(null);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SELECT_CLASS = "gd-line-selected";

// The additive-drag modifier, derived per platform (never a hardcoded key):
// Cmd on macOS, Ctrl elsewhere — Ctrl-click is the secondary click on macOS.
const ADDITIVE_MODIFIER = formatBinding("mod");
const isAdditiveDrag = (e: MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);

/** The diff row for a line. Unified mode tags the number span with
 *  `data-line-{new,old}-num`; split mode uses a generic `data-line-num` inside a
 *  cell marked `data-side`. Try both so either view works. */
function rowForLine(container: HTMLElement, side: "old" | "new", line: number) {
  const unifiedAttr =
    side === "new" ? "data-line-new-num" : "data-line-old-num";
  const span =
    container.querySelector(`span[${unifiedAttr}="${line}"]`) ??
    container.querySelector(
      `td[data-side="${side}"] span[data-line-num="${line}"]`,
    );
  return span?.closest("tr") ?? null;
}

function clearPaint(container: HTMLElement) {
  container
    .querySelectorAll(`.${SELECT_CLASS}`)
    .forEach((el) => el.classList.remove(SELECT_CLASS));
}

/** Highlight exactly these changed lines. */
function paintLines(container: HTMLElement, lines: SelectedLine[]) {
  clearPaint(container);
  for (const { side, line } of lines) {
    rowForLine(container, side, line)?.classList.add(SELECT_CLASS);
  }
}

/** Highlight an in-progress drag range for live feedback (includes context),
 *  over `base` — the lines an additive drag is merging into, which would
 *  otherwise vanish on the next mousemove (this repaints from scratch). */
function paintRange(
  container: HTMLElement,
  range: {
    side: "old" | "new";
    startLineNumber: number;
    endLineNumber: number;
  } | null,
  base: SelectedLine[],
) {
  paintLines(container, base);
  if (!range) return;
  const lo = Math.min(range.startLineNumber, range.endLineNumber);
  const hi = Math.max(range.startLineNumber, range.endLineNumber);
  for (let n = lo; n <= hi; n++) {
    rowForLine(container, range.side, n)?.classList.add(SELECT_CLASS);
  }
}

/** Union of two line selections, deduped by side+line — an additive drag adds
 *  to the committed selection instead of replacing it, and the two can overlap
 *  or (unlike one library-reported drag) span both sides. */
function mergeSelection(
  base: SelectedLine[] | null,
  added: SelectedLine[],
): SelectedLine[] {
  const merged = [...(base ?? [])];
  const seen = new Set(merged.map((s) => `${s.side}|${s.line}`));
  for (const line of added) {
    const key = `${line.side}|${line.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged;
}

/** A hunk's first old/new line number, from its `@@ -a,b +c,d @@` header. */
function hunkStart(hunk: DiffHunk, side: "old" | "new"): number {
  const m = hunk.header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
  return m ? Number(side === "new" ? m[2] : m[1]) : 1;
}

/** The new-side line numbers of a hunk's added (`+`) lines, walking its body
 *  from the header's new start. Used to discard a new file's lines by number;
 *  for an all-additions (untracked) hunk this is every body line. */
function hunkAddedNewLines(hunk: DiffHunk): number[] {
  let n = hunkStart(hunk, "new");
  const out: number[] = [];
  for (const line of hunk.text.split("\n").slice(1)) {
    if (line === "" || line.startsWith("\\")) continue; // split artifact / "\ No newline"
    if (line.startsWith("+")) out.push(n++);
    else if (!line.startsWith("-")) n++; // context advances the new side; "-" doesn't
  }
  return out;
}

interface HunkActionProps {
  hunk: DiffHunk;
  staged: boolean;
  busy: boolean;
  onHunkAction: (hunk: DiffHunk, kind: "stage" | "unstage" | "discard") => void;
}

/** Stage/Unstage + Discard for one hunk — used both overlaid on a `@@` row and
 *  inside the synthetic header a line-1 hunk gets (it has no `@@` row). */
function HunkActionButtons({
  hunk,
  staged,
  busy,
  onHunkAction,
}: HunkActionProps) {
  return (
    <>
      <Button
        variant="secondary"
        size="xs"
        disabled={busy}
        onClick={() => onHunkAction(hunk, staged ? "unstage" : "stage")}
      >
        {staged ? "Unstage" : "Stage"} hunk
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className="text-destructive"
        disabled={busy}
        onClick={() => onHunkAction(hunk, "discard")}
      >
        Discard…
      </Button>
    </>
  );
}

/**
 * The working-tree diff as ONE whole-file view: content-mode highlighting with
 * collapsible expand, drag the line-number gutter to select lines to stage
 * across the whole file, and per-hunk Stage/Unstage/Discard buttons OVERLAID on
 * each hunk header (the library exposes no hunk-header slot). The library's
 * selection manager handles the drag; we paint the `gd-line-selected` highlight
 * ourselves (its own class doesn't apply in this standalone setup).
 */
function StagingDiffView({
  repoPath,
  filePath,
  diffText,
  contentRevs,
  viewMode,
  isDark,
  hunks,
  staged,
  busy,
  selection,
  onSelect,
  onHunkAction,
}: {
  repoPath: string;
  filePath: string;
  diffText: string;
  contentRevs: DiffContentRevs;
  viewMode: string;
  isDark: boolean;
  hunks: DiffHunk[];
  staged: boolean;
  busy: boolean;
  selection: SelectedLine[] | null;
  onSelect: (lines: SelectedLine[] | null, forText: string) => void;
  onHunkAction: (hunk: DiffHunk, kind: "stage" | "unstage" | "discard") => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRepo = useUiStore((s) => s.repoPath);
  const { syntaxMap, customLanguages } = useEffectiveSyntax(activeRepo);
  const deferredText = useDeferredValue(diffText);
  const deferredPath = useDeferredValue(filePath);
  // Hard-shorten over-long lines before rendering so a file with lines in the
  // 4K–20K band can't freeze the un-virtualized renderer here either (past the
  // mega threshold it falls back to the whole-file surface). DISPLAY-ONLY:
  // shortening preserves line COUNT and numbers, so the drag manager, paint
  // helpers, hunk anchors, and every mutation path (all working off the ORIGINAL
  // text) stay correct. Measure once; unchanged files fast-path to the same
  // string reference.
  const { longestLine, displayText, shortened } = useMemo(() => {
    const longest = longestLineLength(deferredText);
    if (longest <= DIFF_MAX_LINE_CHARS) {
      return { longestLine: longest, displayText: deferredText, shortened: 0 };
    }
    const short = shortenLongLines(deferredText, DIFF_MAX_LINE_CHARS);
    return {
      longestLine: longest,
      displayText: short.text,
      shortened: short.shortened,
    };
  }, [deferredText]);
  // Whole-file highlight context + expand. The staging view renders every hunk
  // regardless, so content mode may engage for big diffs too — bounded by the
  // file highlight budget, not the read-only surface's render cap. `pending`
  // holds the paint so the diff is built once in its final layout.
  const { content, pending: contentPending } = useFileContent(
    repoPath,
    deferredPath,
    deferredText,
    // Shortened hunk text (long lines cut) no longer lines up with the
    // whole-file reads content mode maps syntax onto, and the reads are wasted
    // IPC there — skip content mode once any line is over the shorten cap.
    longestLine > DIFF_MAX_LINE_CHARS ? undefined : contentRevs,
    HIGHLIGHT_MAX_LINES,
  );
  // `blocked` is omitted: a mega-line file never reaches this view —
  // WorkingTreeDiff routes it to the whole-file DiffSurface fallback first.
  const { holdForGrammar, grammarState, workerHighlighter } = useShikiRouting({
    filePath: deferredPath,
    text: displayText,
    content: content ?? null,
    contentPending,
    syntaxMap,
    customLanguages,
  });
  // The whole-file diff (every hunk) — never capped, so all hunks stay stageable.
  // Built from the shortened DISPLAY text; the original text still backs every
  // stage/unstage/discard patch (see WorkingTreeDiff). Null while content reads
  // are pending: don't build an intermediate diff the arriving reads would
  // immediately restructure.
  // grammarState: rebuild-trigger dep — see useShikiRouting's contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: grammarState is an intentional rebuild trigger, read via module state not directly
  const diffFile = useMemo(
    () =>
      contentPending || holdForGrammar
        ? null
        : createDiffFile(
            deferredPath,
            displayText,
            { syntaxMap, customLanguages },
            content ?? undefined,
          ),
    [
      deferredPath,
      displayText,
      syntaxMap,
      customLanguages,
      content,
      contentPending,
      holdForGrammar,
      grammarState,
    ],
  );

  // The library can expand collapsed context but offers no way back; track when
  // the user has expanded so we can show a Collapse control. Reset per diff.
  const [expanded, setExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh diff starts collapsed
  useEffect(() => setExpanded(false), [diffFile]);

  // Keep latest callback/selection without re-creating the manager each render.
  const onSelectRef = useLatestRef(onSelect);
  const selectedRef = useLatestRef(selection);

  // Whether the drag in progress started modifier-held. The library's callbacks
  // carry no event, so it's captured from the container's own mousedown on the
  // CAPTURE phase — the manager listens on the same element, bubble phase.
  const additiveRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !diffFile) return;
    const onMouseDownCapture = (e: MouseEvent) => {
      additiveRef.current = isAdditiveDrag(e);
    };
    container.addEventListener("mousedown", onMouseDownCapture, true);
    // An additive drag paints over the committed selection; a plain one replaces
    // it, so its base is empty (the pre-additive behavior).
    const paintBase = () =>
      additiveRef.current ? (selectedRef.current ?? []) : [];
    const manager = createDiffMultiSelectManager(container, diffFile, {
      isUnifiedMode: viewMode !== "split",
      onSelectionChange: (range) => paintRange(container, range, paintBase()),
      onSelectionComplete: (result) => {
        // One drag is single-sided by library contract; the union across drags
        // is what lets a selection carry added AND deleted lines.
        const lines = (result?.lines ?? [])
          .filter((l) => l.isAdd || l.isDelete)
          .map(
            (l): SelectedLine => ({
              side: l.isAdd ? "new" : "old",
              line: l.lineNumber,
            }),
          );
        const next = additiveRef.current
          ? mergeSelection(selectedRef.current, lines)
          : lines;
        // Stamp against the text these rows were BUILT from — the live
        // diff.data.text can already be newer while the deferred render lags.
        onSelectRef.current(next.length ? next : null, deferredText);
      },
    });
    paintLines(container, selectedRef.current ?? []); // re-assert after (re)mount
    return () => {
      container.removeEventListener("mousedown", onMouseDownCapture, true);
      manager.destroy();
    };
  }, [diffFile, viewMode, deferredText]);

  // Paint the committed selection from state (incl. cleared → []).
  useEffect(() => {
    const container = containerRef.current;
    if (container) paintLines(container, selection ?? []);
  }, [selection]);

  // Position each hunk's action overlay by anchoring to that hunk's OWN first
  // row (found by line number), NOT to the Nth `@@` marker row: in content mode
  // those rows mark collapsed gaps, not hunks 1:1 (a change at line 1 has no
  // leading gap → no marker), so a positional map mis-places + mis-fires the
  // buttons. The overlay lives inside the scrolled content, so it tracks scroll
  // without a listener; re-measure only on rebuild/expand/collapse/resize.
  const [anchors, setAnchors] = useState<{ top: number; sep: boolean }[]>([]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !diffFile) return;
    let raf = 0;
    const measure = () => {
      const rootTop = container.getBoundingClientRect().top;
      setAnchors(
        hunks.map((h) => {
          const row =
            rowForLine(container, "new", hunkStart(h, "new")) ??
            rowForLine(container, "old", hunkStart(h, "old"));
          if (!row) return { top: -1, sep: false };
          // A hunk normally has a `@@` separator row right above it (host the
          // buttons there); a hunk at line 1 has none (sep=false) and instead
          // gets a synthetic header bar.
          const prev = row.previousElementSibling;
          const sep = prev?.getAttribute("data-state") === "hunk";
          const anchor = sep ? prev : row;
          return { top: anchor.getBoundingClientRect().top - rootTop, sep };
        }),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [diffFile, hunks]);

  // Whole-file reads still settling, or a lazy built-in Shiki grammar still
  // loading: render nothing rather than build a diff we'd immediately restructure
  // or re-highlight (the single-paint gate). Must precede the empty-state
  // placeholder so loading never reads as "No changes to show". The effects above
  // guard on `!diffFile`, so they no-op while pending and re-bind on the single
  // build.
  if (contentPending || holdForGrammar) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  // A line-1 hunk has no `@@` row to host its buttons — synthetic header instead.
  const firstNeedsHeader =
    !!anchors[0] && anchors[0].top >= 0 && !anchors[0].sep && !!hunks[0];
  return (
    <div
      ref={containerRef}
      className="relative"
      onClick={(e) => {
        // The library's expand controls carry the `diff-widget-tooltip` class; a
        // click on one means the user just expanded context → offer Collapse.
        if ((e.target as HTMLElement).closest(".diff-widget-tooltip")) {
          setExpanded(true);
        }
      }}
    >
      {expanded && (
        <div className="sticky top-0 z-20 flex justify-end border-b bg-muted/70 px-2 py-1 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              diffFile.onAllCollapse(
                viewMode === "split" ? "split" : "unified",
              );
              setExpanded(false);
            }}
          >
            Collapse expanded context
          </Button>
        </div>
      )}
      {firstNeedsHeader && (
        <div
          className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <code
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            title={hunks[0].header}
          >
            {hunks[0].header}
          </code>
          <HunkActionButtons
            hunk={hunks[0]}
            staged={staged}
            busy={busy}
            onHunkAction={onHunkAction}
          />
        </div>
      )}
      <DiffView
        diffFile={diffFile}
        // Worker ASTs land as a highlighter PROP, not a rebuild: the view's
        // effect applies them to its own clone, so expansion state survives.
        registerHighlighter={workerHighlighter}
        diffViewMode={
          viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified
        }
        diffViewTheme={isDark ? "dark" : "light"}
        diffViewHighlight
        diffViewWrap
        diffViewFontSize={12}
      />
      {anchors.map((a, i) =>
        hunks[i] && a.sep && a.top >= 0 ? (
          // Buttons sit ON the `@@` separator row (never on code), right-aligned
          // to clear the native expand controls. mousedown-stop so a button
          // press never starts a drag-select.
          <div
            key={`${i}:${hunks[i].header}`}
            className="absolute right-3 z-10 flex -translate-y-px gap-1"
            style={{ top: a.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HunkActionButtons
              hunk={hunks[i]}
              staged={staged}
              busy={busy}
              onHunkAction={onHunkAction}
            />
          </div>
        ) : null,
      )}
      {shortened > 0 && (
        <div className="flex items-center justify-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {shortened.toLocaleString()} long{" "}
            {shortened === 1 ? "line" : "lines"} shortened for performance
          </span>
        </div>
      )}
    </div>
  );
}
