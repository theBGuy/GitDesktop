import {
  createDiffMultiSelectManager,
  type DiffFile,
  DiffModeEnum,
  DiffView,
} from "@git-diff-view/react";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { InfoNote } from "@/components/info-note";
import { PathText } from "@/components/path-text";
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
import { statusReadFailed } from "@/features/repository/StatusReadError";
import { clipTitleFromText } from "@/lib/clip-title";
import type { SelectedLine } from "@/lib/git/api";
import {
  buildHunkPatch,
  type DiffHunk,
  type ParsedDiff,
  parseHunks,
} from "@/lib/git/hunks";
import {
  repoKeys,
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
  capDiffText,
  DIFF_MAX_LINE_CHARS,
  DIFF_MEGA_LINE_CHARS,
  longestLineLength,
  STAGING_DIFF_LINE_CAP,
  shortenLongLines,
  stagingContentMaxLines,
} from "./cap-diff";
import { DiffLanguagePicker } from "./DiffLanguagePicker";
import { DiffPlaceholder } from "./DiffPlaceholder";
import {
  createDiffFile,
  DiffCapFooter,
  type DiffContentRevs,
  DiffModeToggle,
  DiffSurface,
  useFileContent,
  useShikiRouting,
} from "./DiffSurface";
import { fileExt } from "./diff-lang";
import { useDiffPaneHold, useReportPaneSettled } from "./diff-pane-hold";
import {
  answeredSince,
  answerMark,
  filePaneView,
  HOLD_BOUND_MS,
  type PaneView,
  type StatusWait,
  stagingKeep,
  statusBehind,
  statusWaitFor,
} from "./diff-pane-slots";
import { restingDiffMessage } from "./diff-resting-message";
import {
  collapseAllContext,
  diffRendersRows,
  firstHunkHasSepRow,
  type HunkHeaderData,
  type HunkHost,
  hunkHeaderExtendData,
  hunkHost,
  hunkRange,
  hunkRangeText,
  hunkStart,
} from "./diff-rows";
import { FileSlots, useFileSlots } from "./file-slot";
import { ImagePanes } from "./ImageDiff";
import {
  canPreviewMarkdown,
  type MarkdownDiffView,
  MarkdownDocPreview,
  MarkdownViewToggle,
} from "./MarkdownPreview";
import { SPLIT_MIN_CONTAINER_PX } from "./split-threshold";
import {
  hunkWritesAllowed,
  type StagingSide,
  UNDECODABLE_NOTE_COPY,
} from "./undecodable-note";
import {
  useFocusOnControlsSwap,
  useHiddenTriggerFocus,
} from "./use-hidden-trigger-focus";

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
  // mounts + loads the file landed on (each file is its own keyed slot). The
  // list highlight still uses the live selection.
  const deferredFile = useDeferredValue(selectedFile);
  // A repo switch renders once with the new repo before the deferred selection
  // catches up; that render shows no file, so the old path never mounts (or
  // diffs) against the new repo.
  const deferredRepo = useDeferredValue(repoPath);
  const file = deferredRepo === repoPath ? deferredFile : null;

  // A conflicted file (unmerged index) gets the conflict editor instead of a
  // diff (a combined diff git can't render): per-region + whole-file resolution,
  // or the AI streaming view while a session is active for it. Conflicts always
  // live on the unstaged side.
  const liveEntry = file
    ? status.data?.entries.find((e) => e.path === file.path)
    : undefined;
  const isConflicted =
    liveEntry?.unstaged === "conflicted" || liveEntry?.staged === "conflicted";
  const target = paneTarget(repoPath, file, isConflicted);

  // The last settled view stays painted while a newly selected file prepares
  // out of sight, clipped over it, so a click swaps the pane once.
  const slots = useFileSlots(target);

  return (
    <FileSlots slots={slots} target={target} busy={slots.holding}>
      {(view) => {
        if (view.kind === "file") {
          return (
            <WorkingTreeDiff
              repoPath={view.repo}
              file={view.file}
              focusSink={slots.sinkRef}
            />
          );
        }
        if (view.kind === "conflict") {
          return resolveHere === view.key ? (
            <ConflictResolveView repoPath={repoPath} path={view.key} />
          ) : (
            <ConflictFileView repoPath={repoPath} path={view.key} />
          );
        }
        return (
          <DiffPlaceholder
            message={restingDiffMessage(
              status.isPending,
              status.data?.entries.length ?? 0,
              statusReadFailed(status),
            )}
          />
        );
      }}
    </FileSlots>
  );
}

function paneTarget(
  repoPath: string,
  file: SelectedFile | null,
  conflicted: boolean,
): PaneView<SelectedFile> {
  if (file === null) return { kind: "placeholder" };
  if (conflicted) return { kind: "conflict", key: file.path };
  return filePaneView(repoPath, file);
}

type HunkActionKind = "stage" | "unstage" | "discard";

/** What a patch application does: `--cached` stages or unstages, a plain
 *  reverse apply discards. */
function writeKind(opts: {
  cached: boolean;
  reverse: boolean;
}): HunkActionKind {
  if (!opts.cached) return "discard";
  return opts.reverse ? "unstage" : "stage";
}

// A hunk click refused because the live diff moved past the text it was shown
// from: the house refusal shape, per kind.
const STALE_HUNK_ACTION: Record<HunkActionKind, string> = {
  stage: "The diff just updated — nothing was staged.",
  unstage: "The diff just updated — nothing was unstaged.",
  discard: "The diff just updated — nothing was discarded.",
};

/** Why the hunk and line-selection controls (Clear included) are held: a write
 *  from this pane is in flight or its reads haven't answered yet, or the
 *  displayed diff still trails the text it was given. */
const UPDATING_DIFF_REASON = "Updating the diff…";

/** What an unstaged-side Discard puts back, read from live status when its
 *  confirm opens: the worktree reverts to the index copy, which is the staged
 *  version once anything is staged and the last commit otherwise. */
type DiscardRestores = "remove" | "unknown" | "staged" | "commit";

const DISCARD_BODY: Record<
  DiscardRestores,
  (label: string, path: string) => string
> = {
  commit: (label, path) =>
    `Reverts ${label} in ${path} to the last committed version. This cannot be undone.`,
  staged: (label, path) =>
    `Reverts ${label} in ${path} to the staged version. Staged changes to this file are kept. This cannot be undone.`,
  remove: (label, path) =>
    `Removes ${label} from ${path}. This cannot be undone.`,
  // Status doesn't list the file (not loaded yet, or an answer without it):
  // name no version rather than guess one.
  unknown: (label, path) =>
    `Reverts ${label} in ${path}. This cannot be undone.`,
};

/** The hunk button a write was fired from, so focus can follow the hunks once
 *  the refreshed diff is on screen. */
interface HunkFocus {
  index: number;
  button: HTMLElement;
  /** The button held focus at the press. A mouse press needn't focus it
   *  (WebKit never does), and then focus isn't the pane's to move. */
  hadFocus: boolean;
  /** Fired through the Discard confirm, whose close returns focus later. */
  viaConfirm: boolean;
}

/** A write's landing record. `tookOver` latches once the user moves the pane
 *  themselves during that write: focus still lands, but the landing and its
 *  re-land don't scroll, so neither pulls the view back from them. */
type PendingHunkFocus = HunkFocus & { tookOver: boolean };

/** A selection-bar press (index 0: the bar has no hunks), stamped with the
 *  pane it was pressed in so a rescue never lands in a different one. */
type SelectionPress = HunkFocus & {
  repoPath: string;
  path: string;
  staged: boolean;
};

/** A selection-bar rescue: `settled` once its write succeeded (a Clear has no
 *  write), when the bar's unmount may hand focus to the sink. Never scrolls. */
type SelectionFocus = SelectionPress & { settled: boolean };

/** Keys that scroll the pane from a focused hunk button without activating it.
 *  Space activates every focusable control in the pane, so it is not one. */
const PANE_SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
]);

/** keydown for the hunk buttons and their Discard confirm: an auto-repeat of a
 *  held Enter or Space activates nothing, so one physical press acts once even
 *  when a landing hands focus to the next hunk's button mid-hold. Ctrl, Alt
 *  and Meta chords pass through to app hotkeys untouched. */
function swallowRepeatedActivation(e: ReactKeyboardEvent<HTMLElement>) {
  if (
    e.repeat &&
    (e.key === "Enter" || e.key === " ") &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey
  )
    e.preventDefault();
}

/** How long a landed focus stays re-landable after a later rebuild remounts
 *  its button: past this, the remount is no longer that action's. */
const RELAND_BOUND_MS = 500;

/** The Stage/Unstage button of hunk `index`, when it is on screen. */
function primaryFor(container: HTMLElement, index: number) {
  return (
    container.querySelector<HTMLElement>(`[data-hunk-primary="${index}"]`) ??
    undefined
  );
}

/** One of a hunk's buttons: Stage/Unstage, or Discard… (unstaged side only). */
type HunkControl = "primary" | "secondary";

const HUNK_CONTROL_ATTR: Record<HunkControl, string> = {
  primary: "data-hunk-primary",
  secondary: "data-hunk-secondary",
};

/** Hunk `index`'s button of that kind, when it is on screen. */
function hunkControlFor(
  container: HTMLElement,
  index: number,
  control: HunkControl,
) {
  return (
    container.querySelector<HTMLElement>(
      `[${HUNK_CONTROL_ATTR[control]}="${index}"]`,
    ) ?? undefined
  );
}

/** The hunk button `el` is, with its hunk index, or null for anything else. */
function hunkControlOf(
  el: Element,
): { index: number; control: HunkControl; button: HTMLElement } | null {
  for (const control of ["primary", "secondary"] as const) {
    const raw = el.getAttribute(HUNK_CONTROL_ATTR[control]);
    const index = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isNaN(index) && el instanceof HTMLElement)
      return { index, control, button: el };
  }
  return null;
}

/** Moves focus to `target` only while it is where the hunk action left it: the
 *  pressed button had focus at the press and still does, or lost it to <body>
 *  because the button unmounted. Anywhere else, the user moved it. Returns
 *  whether it moved. */
function landHunkFocus(
  pending: HunkFocus,
  target: HTMLElement | null | undefined,
): boolean {
  if (!target || !pending.hadFocus || !target.isConnected) return false;
  const active = document.activeElement;
  const kept =
    active === pending.button ||
    ((active === null || active === document.body) &&
      !pending.button.isConnected);
  if (kept) target.focus({ preventScroll: true });
  return kept;
}

/** Runs a hunk write: `onSuccess` after it resolves, `onError` on a throw from
 *  either, then `settle` on every path, even when `onError` throws. Module
 *  scope: the React Compiler can't lower a `finally` clause in a component. */
async function settleWrite(
  mutate: () => Promise<unknown>,
  onSuccess: () => void,
  onError: (e: unknown) => void,
  settle: () => void,
): Promise<void> {
  try {
    await mutate();
    onSuccess();
  } catch (e) {
    onError(e);
  } finally {
    settle();
  }
}

/** Which side of the working tree a diff shows, for the non-UTF-8 note's copy. */
function stagingSideOf(untracked: boolean, staged: boolean): StagingSide {
  if (untracked) return "untracked";
  if (staged) return "staged";
  return "unstaged";
}

/**
 * The working-tree variant of the diff pane: hunks render as cards with
 * whole-hunk stage/unstage/discard, plus drag-to-select for staging a subset of
 * lines. Binary, truncated, undecodable (non-UTF-8), and generated/minified (one
 * enormous line) diffs fall back to the plain whole-file surface (which is what
 * shows the generated/minified placeholder and the non-UTF-8 note); untracked
 * text files stage here like any other.
 */
function WorkingTreeDiff({
  repoPath,
  file,
  focusSink,
}: {
  repoPath: string;
  file: SelectedFile;
  /** Where focus lands when a hunk action leaves no hunks to move it to. */
  focusSink: RefObject<HTMLElement | null>;
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
  // Full-text revs aligned to the diff's actual sides: staged = HEAD↔index,
  // unstaged = index↔worktree, added = worktree only. ONE derivation for both
  // arms — the fallback surface, the staging view's highlight context, the
  // markdown preview, and the preview-availability predicate all read it.
  const workingRevs: DiffContentRevs = untracked
    ? { newRev: null }
    : file.staged
      ? { oldRev: "HEAD", newRev: ":0" }
      : { oldRev: ":0", newRev: null };
  const diff = useFileDiff(repoPath, { ...file, untracked });
  const stagingSide = stagingSideOf(untracked, file.staged);
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
    // Captured at open, like `run`: the close effect below drops the confirm
    // once the text moves, so its copy can't change while it's up.
    restores: DiscardRestores;
    // The diff text the confirm's `run` was built against — see the close
    // effect below.
    forText: string;
  } | null>(null);
  // Live status, never the diff text (the discard always restores the index
  // copy). Any staged change wins: if status lags with one, the index still
  // equals HEAD, so "the staged version" stays true.
  const discardRestores: DiscardRestores = untracked
    ? "remove"
    : liveEntry === undefined
      ? "unknown"
      : liveEntry.staged != null
        ? "staged"
        : "commit";
  // Declared with the hooks above the fallback's early return below.
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
  // Show full diff past the staging cap. Per file and side: this component is
  // keyed per slot, so it survives the status poll and this file's own stages
  // and resets when the selection moves.
  const [showFull, setShowFull] = useState(false);
  const {
    wrapRef: langWrapRef,
    controlsRef,
    returnFocusIfTriggerHidden,
  } = useHiddenTriggerFocus();
  // A write from this pane, from the press until the reads it changed have
  // answered again: `settled` is null while the write runs, then holds the
  // answer marks the reads' cache entries showed at the settle. Pressing sets
  // it too, since `isPending` reaches render a task after the press.
  const [write, setWrite] = useState<{
    // A stage or unstage, which keeps the view through an emptied side; a
    // discard paints whatever its answer is.
    keeps: boolean;
    settled: {
      diff: ReadonlySet<string>;
      // The status answer the hold may also wait on (`statusWaitFor`), with
      // the marks status showed at the settle.
      status: {
        wait: Exclude<StatusWait, null>;
        marks: ReadonlySet<string>;
      } | null;
    } | null;
  } | null>(null);
  // The fire-time refusal: set synchronously at the press and cleared when the
  // hold releases, so a second press inside the same frame never fires.
  const writingRef = useRef(false);
  const hunkFocusRef = useRef<PendingHunkFocus | null>(null);
  // The latest write's record, kept past its landing (which clears
  // `hunkFocusRef`) so view input in the landing's frame or its re-land window
  // still latches; the next write replaces it.
  const scrollCycleRef = useRef<PendingHunkFocus | null>(null);
  // The selection bar's rescue, apart from `hunkFocusRef`: the hunk landing
  // would aim it at a hunk button.
  const selectionFocusRef = useRef<SelectionFocus | null>(null);
  // The scrolling pane the hunks render in: only input inside it can take over
  // a landing's scroll.
  const scrollPaneRef = useRef<HTMLDivElement>(null);
  // A pointer press anywhere drops the pending landing (scrollbar drags and
  // autoscroll press too): a click into the code also leaves focus on <body>,
  // which would read as the pressed button unmounting. In-pane wheel, touch,
  // scroll keys, or focus onto another in-pane control latch `tookOver`, which
  // cancels only the landing's scroll; focus leaving the pane doesn't, and keys
  // never drop it (a focus-moving one fails the landing's focus check).
  useEffect(() => {
    const drop = () => {
      hunkFocusRef.current = null;
      selectionFocusRef.current = null;
    };
    const inPane = (target: EventTarget | null) =>
      target instanceof Node &&
      scrollPaneRef.current?.contains(target) === true;
    const latch = (e: Event) => {
      const cycle = scrollCycleRef.current;
      if (cycle !== null && inPane(e.target)) cycle.tookOver = true;
    };
    const latchKey = (e: KeyboardEvent) => {
      if (PANE_SCROLL_KEYS.has(e.key)) latch(e);
    };
    // Pending only: the landing's own focus move comes after it clears the ref.
    const latchFocus = (e: FocusEvent) => {
      const pending = hunkFocusRef.current;
      if (pending !== null && e.target !== pending.button && inPane(e.target))
        pending.tookOver = true;
    };
    const passive = { capture: true, passive: true };
    document.addEventListener("pointerdown", drop, true);
    document.addEventListener("wheel", latch, passive);
    document.addEventListener("touchmove", latch, passive);
    document.addEventListener("keydown", latchKey, passive);
    document.addEventListener("focusin", latchFocus, true);
    return () => {
      document.removeEventListener("pointerdown", drop, true);
      document.removeEventListener("wheel", latch, true);
      document.removeEventListener("touchmove", latch, true);
      document.removeEventListener("keydown", latchKey, true);
      document.removeEventListener("focusin", latchFocus, true);
      // An <Activity> re-show replays this effect: a stale rescue must not fire.
      selectionFocusRef.current = null;
    };
  }, []);
  // The Discard confirm is closing: Base UI returns focus from the popup's
  // unmount, which is what fires `onOpenChangeComplete(false)`, so a focus
  // move waits for that edge or the return would undo it.
  const [confirmClosing, setConfirmClosing] = useState(false);
  const queryClient = useQueryClient();
  // Released by the reads' own answers rather than an awaited refetch: an
  // invalidation elsewhere can cancel and restart a joined refetch, and this
  // way the release renders in the same commit as the data it waited for. An
  // answer that is an error releases too, so a failed refresh never strands
  // the buttons.
  const settled = write?.settled ?? null;
  const diffBehind = settled !== null && !answeredSince(diff, settled.diff);
  // This side's answer is empty: a press may have emptied it, which only
  // status can confirm.
  const emptyAnswer = diff.data !== undefined && diff.data.text.trim() === "";
  const statusWaiting =
    settled?.status != null &&
    statusBehind(
      settled.status.wait,
      answeredSince(status, settled.status.marks),
      { answered: !diffBehind, empty: emptyAnswer },
    );
  const refreshing =
    write !== null && (settled === null || diffBehind || statusWaiting);
  const onSide = file.staged
    ? liveEntry?.staged != null
    : liveEntry?.unstaged != null;
  // Before paint, so a button enabled by the release can't meet a stale ref.
  useLayoutEffect(() => {
    if (write === null || refreshing) return;
    writingRef.current = false;
    setWrite(null);
  }, [write, refreshing]);
  // Never strand the hold: a read with no answer since the settle and no fetch
  // in flight (the settle's invalidation already landed, or it skipped this
  // read) fetches once more. Effects stop at unmount, so a pane that no
  // longer shows this file never fetches for it.
  const diffIdle = diff.fetchStatus === "idle";
  const statusIdle = status.fetchStatus === "idle";
  const refetchDiff = diff.refetch;
  const refetchStatus = status.refetch;
  useEffect(() => {
    if (diffBehind && diffIdle) void refetchDiff({ cancelRefetch: false });
    if (statusWaiting && statusIdle)
      void refetchStatus({ cancelRefetch: false });
  }, [
    diffBehind,
    diffIdle,
    statusWaiting,
    statusIdle,
    refetchDiff,
    refetchStatus,
  ]);
  const selectionBinding =
    useEffectiveBindings().get("stage-selected-lines") ?? null;

  const parsed: ParsedDiff | null = useMemo(() => {
    const data = diff.data;
    // A generated/minified file (one enormous line) would freeze the
    // un-virtualized staging renderer — route it down the whole-file
    // DiffSurface fallback, which shows the generated/minified placeholder.
    // An undecodable diff goes there too: a lossy decode must never be handed
    // back to `git apply`.
    if (
      !data ||
      !hunkWritesAllowed(data) ||
      data.isBinary ||
      data.isTruncated ||
      longestLineLength(data.text) > DIFF_MEGA_LINE_CHARS
    )
      return null;
    return parseHunks(data.text);
  }, [diff.data]);
  // The fire-time belt reads this, never a handler's own `diff.data`: every
  // handler below closes over a render where the flag may still have been false.
  const liveDiffRef = useLatestRef(diff.data);

  // A truncated parse could cut a hunk in half — never offer to apply one.
  // Untracked text files line-stage too: `git apply --cached` of a subset of a
  // new-file patch creates the index entry directly (no intent-to-add needed),
  // so part of a new file can be committed. Binary/huge untracked files have
  // `parsed === null` and still fall through to the whole-file view below.
  const hunkMode = parsed !== null && parsed.hunks.length > 0;
  const liveText = diff.data?.text;
  // The old side's whole-file reads follow the staged diff's own pairing (a
  // rename's source), riding the view so a kept view keeps its own.
  const liveOldPath = diff.data?.oldPath ?? file.path;
  const liveView = useMemo(
    () =>
      hunkMode && parsed !== null && liveText !== undefined
        ? { text: liveText, hunks: parsed.hunks, oldPath: liveOldPath }
        : null,
    [hunkMode, parsed, liveText, liveOldPath],
  );
  // A held or preparing slot is inert, but hotkeys and the portaled Discard
  // confirm reach past `inert`, so each gates on this as well.
  const { interactive } = useDiffPaneHold();
  // The hunk view on screen stays painted, its controls held, where falling
  // back would repaint the pane (see `stagingKeep`): a held slot paints what it
  // settled with, and it is held exactly when a press's release and the
  // selection's move land in one render. Only this pane's own stage or
  // unstage sets the emptied keep, so an external change paints as it lands.
  // The emptied keep is a token, so its bound can't outlive it.
  const [lastView, setLastView] = useState(liveView);
  const [emptied, setEmptied] = useState<object | null>(null);
  const [leftExpiredFor, setLeftExpiredFor] = useState<object | null>(null);
  const keep = stagingKeep(
    { hasView: lastView !== null, emptied: emptied !== null },
    {
      live: liveView !== null,
      interactive,
      writeHolding: refreshing && write?.keeps === true,
      emptiedByWrite:
        write?.keeps === true && settled !== null && !diffBehind && emptyAnswer,
      writeReleased: write === null,
      onSide,
      nonEmptyAnswer: diff.data !== undefined && !emptyAnswer,
      leftBoundExpired: emptied !== null && leftExpiredFor === emptied,
    },
  );
  const kept = keep.kept;
  const shownView = liveView ?? (kept ? lastView : null);
  if (shownView !== lastView) setLastView(shownView);
  if (keep.emptied !== (emptied !== null)) setEmptied(keep.emptied ? {} : null);
  // Status took the file off this side: the selection's move or prune is due a
  // render later, but a collapsed Changes list never prunes, so the keep lets
  // go after the bound.
  const leftSide = emptied !== null && write === null && !onSide;
  useEffect(() => {
    if (!leftSide || emptied === null) return;
    const bound = window.setTimeout(
      () => setLeftExpiredFor(emptied),
      HOLD_BOUND_MS,
    );
    return () => window.clearTimeout(bound);
  }, [leftSide, emptied]);
  // `busy` is computed above the early return because the hotkey
  // registrations below run unconditionally and read it.
  const busy =
    applyPatch.isPending ||
    applyPartial.isPending ||
    discardUntracked.isPending ||
    refreshing ||
    kept;
  // A selection is valid only against the diff text it was dragged against —
  // stale by text means every consumer sees no selection at the same instant.
  const selection =
    selectionState !== null && selectionState.forText === liveText
      ? selectionState.lines
      : null;

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

  // Every write from this pane: refused while another is held, then held from
  // the press until the reads it invalidated answer again, with data or an
  // error (see `write`).
  async function runWrite(
    mutate: () => Promise<unknown>,
    focus: HunkFocus | null,
    kind: HunkActionKind,
    rescue: SelectionPress | null = null,
  ) {
    if (writingRef.current) return;
    // A diff gone from the cache refuses too, silently: it has no flag to name.
    const live = liveDiffRef.current;
    if (!hunkWritesAllowed(live)) {
      if (live?.undecodable === true)
        toast.info(UNDECODABLE_NOTE_COPY[stagingSide]);
      return;
    }
    writingRef.current = true;
    const pending = focus === null ? null : { ...focus, tookOver: false };
    hunkFocusRef.current = pending;
    scrollCycleRef.current = pending;
    // Every accepted write replaces the rescue, so a stale one never fires.
    const armed = rescue === null ? null : { ...rescue, settled: false };
    selectionFocusRef.current = armed;
    const wait = statusWaitFor(kind, untracked);
    const keeps = kind !== "discard";
    setWrite({ keeps, settled: null });
    const succeeded = () => {
      // Before the clear, whose commit is where the rescue fires.
      if (armed !== null && selectionFocusRef.current === armed)
        armed.settled = true;
      clearSelection();
    };
    // A failed write keeps its selection, so the bar stays: a rescue left armed
    // would fire on some later, unrelated unmount.
    const failed = (e: unknown) => {
      if (armed !== null && selectionFocusRef.current === armed)
        selectionFocusRef.current = null;
      onError(e);
    };
    await settleWrite(mutate, succeeded, failed, () => {
      // The mutation's settle has already invalidated the reads, so any answer
      // past the marks taken here describes the tree after this write. Every
      // entry under the diff's prefix is marked: the untracked axis can move
      // the shown query to a sibling key mid-hold.
      const cache = queryClient.getQueryCache();
      const marks = (queryKey: QueryKey, exact: boolean) =>
        new Set(
          cache.findAll({ queryKey, exact }).map((q) => answerMark(q.state)),
        );
      setWrite({
        keeps,
        settled: {
          diff: marks(repoKeys.diff(repoPath, file.path, file.staged), false),
          status:
            wait === null
              ? null
              : { wait, marks: marks(repoKeys.status(repoPath), true) },
        },
      });
    });
  }

  function applyHunk(
    hunk: DiffHunk,
    opts: { cached: boolean; reverse: boolean },
    focus: HunkFocus,
  ) {
    if (!parsed) return;
    const patch = buildHunkPatch(parsed, hunk);
    void runWrite(
      () => applyPatch.mutateAsync({ patch, ...opts }),
      focus,
      writeKind(opts),
    );
  }

  // Stage/unstage/discard the file-wide line selection. `build_partial_patch`
  // already distributes a multi-hunk selection, so hand it the WHOLE diff.
  function applySelection(
    opts: { cached: boolean; reverse: boolean },
    rescue: SelectionPress | null,
  ) {
    if (!selection || !diff.data) return;
    const diffText = diff.data.text;
    const selected = selection;
    void runWrite(
      () => applyPartial.mutateAsync({ diffText, selected, ...opts }),
      null,
      writeKind(opts),
      rescue,
    );
  }

  // Discard lines from an untracked (new) file: remove just those new-side line
  // numbers from the file. A new file is all additions, so there's nothing to
  // reverse-apply (reverse-applying its patch would delete the whole file).
  function discardLines(
    lines: number[],
    focus: HunkFocus | null,
    rescue: SelectionPress | null = null,
  ) {
    if (lines.length === 0) return;
    const path = file.path;
    void runWrite(
      () => discardUntracked.mutateAsync({ path, lines }),
      focus,
      "discard",
      rescue,
    );
  }

  // A selection-bar press on `button`, for the rescue its route arms.
  function selectionPress(
    button: HTMLElement,
    viaConfirm: boolean,
  ): SelectionPress {
    return {
      index: 0,
      button,
      hadFocus: document.activeElement === button,
      viaConfirm,
      repoPath,
      path: file.path,
      staged: file.staged,
    };
  }

  // A selection hotkey rescues only focus it strands: on a bar control (the
  // bar's own tabIndex=-1 span survives the swap), or, for a write, whose
  // rebuild remounts the hunks, on a hunk button. Elsewhere it isn't the pane's.
  function hotkeyPress(forWrite: boolean): SelectionPress | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const bar = controlsRef.current;
    const onBar = active !== bar && bar?.contains(active) === true;
    const onHunk =
      forWrite &&
      hunkControlOf(active) !== null &&
      scrollPaneRef.current?.contains(active) === true;
    return onBar || onHunk ? selectionPress(active, false) : null;
  }

  // A whole-hunk action, fired by the per-hunk buttons with the diff text that
  // hunk was parsed from and the button pressed.
  function onHunkAction(
    hunk: DiffHunk,
    kind: HunkActionKind,
    forText: string,
    focus: HunkFocus,
  ) {
    // The staged side offers no Discard (it would revert the working tree,
    // not the staged hunk); a press that reaches here anyway is refused aloud.
    if (kind === "discard" && file.staged) {
      toast.info(STALE_HUNK_ACTION.discard);
      return;
    }
    if (writingRef.current) return;
    // A hunk from a stale display would patch lines the user never saw.
    if (forText !== (diff.data?.text ?? "")) {
      toast.info(STALE_HUNK_ACTION[kind]);
      return;
    }
    const live = liveDiffRef.current;
    if (!hunkWritesAllowed(live)) {
      toast.info(
        live?.undecodable === true
          ? UNDECODABLE_NOTE_COPY[stagingSide]
          : STALE_HUNK_ACTION[kind],
      );
      return;
    }
    if (kind === "discard") {
      setDiscard({
        label: `the hunk at ${hunkRangeText(hunk)}`,
        restores: discardRestores,
        forText,
        run: untracked
          ? () => discardLines(hunkAddedNewLines(hunk), focus)
          : () => applyHunk(hunk, { cached: false, reverse: true }, focus),
      });
    } else {
      applyHunk(hunk, { cached: true, reverse: kind === "unstage" }, focus);
    }
  }

  // Preview swaps the staging view out entirely, so the selection actions and
  // the toggle can never be on screen together (the selection arm owns the
  // whole cluster while a drag selection exists). Same predicate as the
  // read-only surface, so the two hosts can't drift on what's previewable.
  const canPreview =
    shownView !== null && canPreviewMarkdown(file.path, repoPath, workingRevs);
  const previewOn = canPreview && mdView === "preview";
  useFocusOnControlsSwap(previewOn, controlsRef);
  // Swapping between the staging view and the whole-file fallback (the file
  // turned empty, header-only or binary, or back) unmounts the toolbar control
  // that held focus: land on the sink. A cold load's first hunk view swaps in
  // from nothing too, so focus that was on <body> then lands there as well.
  useFocusOnControlsSwap(shownView !== null, focusSink);
  // A confirm pending when the slot is held is dropped, not just hidden: a
  // retarget back to this file must never reopen it.
  if (!interactive && discard !== null) setDiscard(null);
  // One contextual chord: stage the selection on an unstaged file's diff,
  // unstage it on a staged one — mirroring the toolbar's primary button. Dead
  // while the Discard confirm is open (the global listener has no dialog guard)
  // and while the non-staging fallback renders.
  useHotkeyAction(
    "stage-selected-lines",
    () =>
      applySelection({ cached: true, reverse: file.staged }, hotkeyPress(true)),
    interactive && hunkMode && selection !== null && !busy && discard === null,
  );
  useHotkeyAction(
    "clear-line-selection",
    () => {
      const press = hotkeyPress(false);
      selectionFocusRef.current =
        press === null ? null : { ...press, settled: true };
      clearSelection();
    },
    interactive && hunkMode && selection !== null && !busy && discard === null,
  );
  // Only this toolbar's own arm registers: while no hunk view is shown, the
  // fallback DiffSurface below renders the picker and registers for itself,
  // and a child's effect runs first — so an ungated registration here would
  // win the dispatch (newest handler) and open a toolbar that isn't on screen.
  // The selection arm replaces the picker with its stage/discard buttons,
  // hence `selection`.
  useHotkeyAction(
    "change-diff-language",
    () => setLangOpen(true),
    // In Preview the picker isn't mounted, so the action would open nothing.
    interactive &&
      shownView !== null &&
      selection === null &&
      !previewOn &&
      Boolean(fileExt(file.path)),
  );
  // Inert while a selection or the Discard confirm is up — the selection arm
  // owns the cluster, and the global listener has no dialog guard.
  useHotkeyAction(
    "toggle-markdown-preview",
    () => setMdView((v) => (v === "raw" ? "preview" : "raw")),
    interactive && canPreview && selection === null && discard === null,
  );
  // Any Discard confirm's `run` captured line numbers (or a hunk) at open
  // time — close it the moment the diff text moves on from the text it was
  // opened against (a refetch while the dialog is up), whichever arm opened it.
  useEffect(() => {
    if (discard !== null && discard.forText !== liveText) setDiscard(null);
  }, [discard, liveText]);
  // The fallback view renders no confirm, so a close in progress ended with
  // its unmount: nothing is left to wait for.
  if (shownView === null && confirmClosing) setConfirmClosing(false);
  // A flag flip can leave the decoded text byte-identical, so the text-keyed
  // guards above never fire for it; leaving hunk mode clears both here.
  if (!hunkMode && selectionState !== null) setSelectionState(null);
  if (!hunkMode && discard !== null) setDiscard(null);
  // The selection bar's rescue lands once its write settled (a Clear at its
  // press) and the bar is gone, on the pane's sink under the landing rule. A
  // mid-write liveText drift or hunk-mode exit leaves focus on <body> until the
  // settle, then the rescue lands if these gates still hold; a write that fails
  // after such an unmount clears the record and focus stays on <body>. No
  // dependency array: it keys on ref state set outside render.
  useLayoutEffect(() => {
    const rescue = selectionFocusRef.current;
    if (rescue === null) return;
    if (
      !interactive ||
      rescue.repoPath !== repoPath ||
      rescue.path !== file.path ||
      rescue.staged !== file.staged
    ) {
      selectionFocusRef.current = null;
      return;
    }
    if (!rescue.settled || selection !== null || confirmClosing) return;
    selectionFocusRef.current = null;
    const land = () => landHunkFocus(rescue, focusSink.current);
    if (!rescue.viaConfirm) land();
    // A frame past the confirm's unmount, so the move lands after its return.
    else requestAnimationFrame(land);
  });

  if (shownView === null) {
    return (
      <DiffSurface
        filePath={file.path}
        diff={diff}
        repoPath={repoPath}
        // staged view compares HEAD → index; unstaged compares HEAD → worktree
        imageRevs={
          file.staged ? { old: "HEAD", new: ":0" } : { old: "HEAD", new: null }
        }
        contentRevs={workingRevs}
        stagingSide={stagingSide}
      />
    );
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
        <PathText
          path={file.path}
          className="flex-1 font-mono text-xs text-muted-foreground"
        />
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
                <DisabledReasonButton
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  reason={UPDATING_DIFF_REASON}
                  title={selectionTitle}
                  aria-keyshortcuts={selectionKeyshortcuts}
                  onClick={(e) =>
                    applySelection(
                      { cached: true, reverse: true },
                      selectionPress(e.currentTarget, false),
                    )
                  }
                >
                  Unstage
                </DisabledReasonButton>
              ) : (
                <>
                  <DisabledReasonButton
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    reason={UPDATING_DIFF_REASON}
                    title={selectionTitle}
                    aria-keyshortcuts={selectionKeyshortcuts}
                    onClick={(e) =>
                      applySelection(
                        { cached: true, reverse: false },
                        selectionPress(e.currentTarget, false),
                      )
                    }
                  >
                    Stage
                  </DisabledReasonButton>
                  <DisabledReasonButton
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    disabled={busy}
                    reason={UPDATING_DIFF_REASON}
                    onClick={(e) => {
                      // Armed only when the confirm runs, so Cancel arms none.
                      const press = selectionPress(e.currentTarget, true);
                      setDiscard({
                        label: `${selection.length} selected ${selection.length === 1 ? "line" : "lines"}`,
                        restores: discardRestores,
                        forText: diff.data?.text ?? "",
                        run: untracked
                          ? () =>
                              discardLines(
                                selection
                                  .filter((s) => s.side === "new")
                                  .map((s) => s.line),
                                null,
                                press,
                              )
                          : () =>
                              applySelection(
                                { cached: false, reverse: true },
                                press,
                              ),
                      });
                    }}
                  >
                    Discard…
                  </DisabledReasonButton>
                </>
              )}
              <DisabledReasonButton
                variant="ghost"
                size="xs"
                disabled={busy}
                reason={UPDATING_DIFF_REASON}
                onClick={(e) => {
                  selectionFocusRef.current = {
                    ...selectionPress(e.currentTarget, false),
                    settled: true,
                  };
                  clearSelection();
                }}
              >
                Clear
              </DisabledReasonButton>
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
      <div
        ref={scrollPaneRef}
        className="ph-no-capture min-h-0 flex-1 overflow-auto"
      >
        {file.path.toLowerCase().endsWith(".svg") && (
          <div className="border-b">
            <ImagePanes
              repoPath={repoPath}
              filePath={file.path}
              oldPath={shownView.oldPath}
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
            oldPath={shownView.oldPath}
            revs={workingRevs}
          />
        ) : (
          <>
            {/* The drag-the-line-numbers hint is about the staging gutter, so
                it stays out of Preview, which has no line numbers at all. */}
            {(settings.data?.showLineStageHint ?? true) && (
              <InfoNote
                action={
                  <button
                    type="button"
                    onClick={() => {
                      if (!settings.data) return;
                      // A dismissed hint is cosmetic: a failed write only means
                      // it shows again next time, which needs no toast.
                      void saveSettings
                        .mutateAsync({
                          ...settings.data,
                          showLineStageHint: false,
                        })
                        .catch(() => undefined);
                    }}
                    className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2 hover:no-underline"
                  >
                    Don't show again
                  </button>
                }
              >
                Drag across the line numbers to{" "}
                {file.staged ? "unstage" : "stage"} just those lines, added and
                removed alike. Hold Shift while dragging to take one side of a
                change, or {ADDITIVE_MODIFIER} to add to the selection.
                {selectionBinding !== null && (
                  <>
                    {" "}
                    Press {formatBinding(selectionBinding)} to{" "}
                    {file.staged ? "unstage" : "stage"} the selection.
                  </>
                )}
              </InfoNote>
            )}
            <StagingDiffView
              repoPath={repoPath}
              filePath={file.path}
              oldPath={shownView.oldPath}
              diffText={shownView.text}
              contentRevs={workingRevs}
              viewMode={viewMode}
              isDark={isDark}
              hunks={shownView.hunks}
              staged={file.staged}
              busy={busy}
              frozen={kept}
              selection={selection}
              onSelect={(lines, forText) =>
                setSelectionState(lines === null ? null : { lines, forText })
              }
              onHunkAction={onHunkAction}
              hunkFocusRef={hunkFocusRef}
              focusHeld={confirmClosing}
              focusSink={focusSink}
              scrollPaneRef={scrollPaneRef}
              showFull={showFull}
              onShowFull={() => setShowFull(true)}
            />
          </>
        )}
      </div>

      <Dialog
        open={discard !== null && interactive}
        onOpenChange={(open) => {
          if (!open) setDiscard(null);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setConfirmClosing(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {shownDiscard &&
                DISCARD_BODY[shownDiscard.restores](
                  shownDiscard.label,
                  file.path,
                )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/* A held Enter that opened the confirm repeats into whichever of
                these has focus (Cancel, on open): it must not act on it. */}
            <Button
              variant="outline"
              onKeyDown={swallowRepeatedActivation}
              onClick={() => setDiscard(null)}
            >
              Cancel
            </Button>
            <DisabledReasonButton
              variant="destructive"
              disabled={busy}
              reason={UPDATING_DIFF_REASON}
              onKeyDown={swallowRepeatedActivation}
              onClick={() => {
                setConfirmClosing(true);
                discard?.run();
                setDiscard(null);
              }}
            >
              Discard
            </DisabledReasonButton>
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

// The gutter cells the selection manager starts a drag from: unified's single
// number column, and split's two per-side ones. What the anchor latch checks.
const GUTTER_CELL = ".diff-line-num, .diff-line-old-num, .diff-line-new-num";

/** A drag's anchor rows plus the sides it takes: `null` = both sides of every
 *  crossed row (a plain drag), a side = only that one (a split Shift drag). */
interface DragAnchors {
  startRow: HTMLTableRowElement;
  endRow: HTMLTableRowElement;
  side: "old" | "new" | null;
}

/** The number span for a line. Unified mode tags it `data-line-{new,old}-num`;
 *  split mode uses a generic `data-line-num` inside a cell marked `data-side`.
 *  Try both so either view works; a caller that knows it is in split passes
 *  `split` to skip the unified probe, which can never match there. A placeholder
 *  (a split row's empty side) carries no such span, so it can never resolve.
 *  PRECONDITION: only the wrap-mode split renderer puts `data-side` on the
 *  CELLS (the normal one puts it on the row and splits the sides across two
 *  tables), so the split arm here and in `splitRowSpans` requires the view's
 *  `diffViewWrap`. */
function numSpanForLine(
  container: HTMLElement,
  side: "old" | "new",
  line: number,
  split = false,
) {
  const unifiedAttr =
    side === "new" ? "data-line-new-num" : "data-line-old-num";
  return (
    (split
      ? null
      : container.querySelector(`span[${unifiedAttr}="${line}"]`)) ??
    container.querySelector(
      `td[data-side="${side}"] span[data-line-num="${line}"]`,
    )
  );
}

/** The diff row for a line, in either view. */
function rowForLine(container: HTMLElement, side: "old" | "new", line: number) {
  return numSpanForLine(container, side, line)?.closest("tr") ?? null;
}

/** A hunk's first row, by line number: what its buttons are hosted from, and
 *  what counts as its rows being on screen. */
function hunkFirstRow(container: HTMLElement, hunk: DiffHunk) {
  return (
    rowForLine(container, "new", hunkStart(hunk, "new")) ??
    rowForLine(container, "old", hunkStart(hunk, "old"))
  );
}

/** The old/new number spans a split (wrap-mode) row carries. Absent where that
 *  side is a placeholder (the empty half of a pure add or delete) or the row is
 *  a `@@` separator, expand control, or widget — none of which hold a number. */
function splitRowSpans(row: Element) {
  return {
    old: row.querySelector('td[data-side="old"] span[data-line-num]'),
    new: row.querySelector('td[data-side="new"] span[data-line-num]'),
  };
}

/** The number a split row's `data-line-num` span holds. */
function spanLineNum(span: Element | null): number | undefined {
  const raw = span?.getAttribute("data-line-num");
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isNaN(n) ? undefined : n;
}

/** Paint one side of a split row: the number cell the span lives in and the
 *  content cell beside it. Reaching them through the span is what keeps a
 *  placeholder side untinted. */
function paintSide(span: Element) {
  const numCell = span.closest("td");
  if (!numCell) return;
  numCell.classList.add(SELECT_CLASS);
  numCell.nextElementSibling?.classList.add(SELECT_CLASS);
}

function clearPaint(container: HTMLElement) {
  container
    .querySelectorAll(`.${SELECT_CLASS}`)
    .forEach((el) => el.classList.remove(SELECT_CLASS));
}

/** Highlight exactly these changed lines — whole rows in unified, and in split
 *  only the cells of each line's own side, so a one-sided selection reads as
 *  one-sided. */
function paintLines(
  container: HTMLElement,
  lines: SelectedLine[],
  split: boolean,
) {
  clearPaint(container);
  for (const { side, line } of lines) {
    if (split) {
      const span = numSpanForLine(container, side, line, split);
      if (span) paintSide(span);
    } else {
      rowForLine(container, side, line)?.classList.add(SELECT_CLASS);
    }
  }
}

/** Highlight the library-reported drag range for live feedback (includes
 *  context), over `base` — the lines an additive drag is merging into, which
 *  would otherwise vanish on the next mousemove (this repaints from scratch).
 *  The unified Shift drag's painter; every other drag reaches it only with no
 *  anchors — a cleared (null) range, an unresolvable start row, or no live
 *  primary gutter press (one already released, or a non-primary-button
 *  drag) — otherwise `paintRowSpan`. */
function paintRange(
  container: HTMLElement,
  range: {
    side: "old" | "new";
    startLineNumber: number;
    endLineNumber: number;
  } | null,
  base: SelectedLine[],
  split: boolean,
) {
  paintLines(container, base, split);
  if (!range) return;
  const lo = Math.min(range.startLineNumber, range.endLineNumber);
  const hi = Math.max(range.startLineNumber, range.endLineNumber);
  for (let n = lo; n <= hi; n++) {
    if (split) {
      const span = numSpanForLine(container, range.side, n, split);
      if (span) paintSide(span);
    } else {
      rowForLine(container, range.side, n)?.classList.add(SELECT_CLASS);
    }
  }
}

/** The old/new numbers a row carries; neither = a `@@` separator, expand
 *  control, or widget, in both views. Unified: both = context, one = added or
 *  removed. Split: a row pairs the sides, so a modification carries both
 *  numbers too and only the diff's changed sets tell the shapes apart
 *  (`splitLinesForRows` classifies). An unparseable number counts as absent,
 *  matching the library's own validity test. */
function rowLineNumbers(
  row: Element,
  split: boolean,
): { old?: number; new?: number } {
  if (split) {
    const spans = splitRowSpans(row);
    return { old: spanLineNum(spans.old), new: spanLineNum(spans.new) };
  }
  const read = (attr: string) => {
    const raw = row
      .querySelector(`.diff-line-num span[${attr}]`)
      ?.getAttribute(attr);
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isNaN(n) ? undefined : n;
  };
  return { old: read("data-line-old-num"), new: read("data-line-new-num") };
}

/** The rows a drag crossed, inclusive and in document order (either drag
 *  direction). Empty when an anchor has left the DOM — the signal callers
 *  use to fall back to the library's own range. */
function rowsBetween(
  container: HTMLElement,
  startRow: HTMLTableRowElement,
  endRow: HTMLTableRowElement,
): HTMLTableRowElement[] {
  const rows = Array.from(
    container.querySelectorAll<HTMLTableRowElement>("tr"),
  );
  const a = rows.indexOf(startRow);
  const b = rows.indexOf(endRow);
  if (a < 0 || b < 0) return [];
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Highlight an anchored drag's crossed rows over `base` (same additive base as
 *  `paintRange`). Context rows in the span tint for live feedback and numberless
 *  rows never do; split tints the drag's sides on every row that has them. The
 *  commit keeps only the changed lines among them — context drops via the sets. */
function paintRowSpan(
  container: HTMLElement,
  drag: DragAnchors,
  base: SelectedLine[],
  split: boolean,
) {
  paintLines(container, base, split);
  for (const row of rowsBetween(container, drag.startRow, drag.endRow)) {
    if (split) {
      const spans = splitRowSpans(row);
      if (drag.side !== "new" && spans.old) paintSide(spans.old);
      if (drag.side !== "old" && spans.new) paintSide(spans.new);
      continue;
    }
    const { old: oldNum, new: newNum } = rowLineNumbers(row, false);
    if (oldNum !== undefined || newNum !== undefined)
      row.classList.add(SELECT_CLASS);
  }
}

/** The changed lines of a unified crossed-row span — a row with both numbers is
 *  context and one with neither is a separator, so both drop out. */
function linesForRows(rows: HTMLTableRowElement[]): SelectedLine[] {
  const out: SelectedLine[] = [];
  for (const row of rows) {
    const { old: oldNum, new: newNum } = rowLineNumbers(row, false);
    if (oldNum !== undefined && newNum !== undefined) continue;
    if (oldNum !== undefined) out.push({ side: "old", line: oldNum });
    else if (newNum !== undefined) out.push({ side: "new", line: newNum });
  }
  return out;
}

/** The changed lines of a split crossed-row span, restricted to `side` (null =
 *  both). A split row pairs the two sides, so each side's number is classified
 *  against the diff's own `-`/`+` sets rather than the row's shape: context and
 *  expanded context sit in neither set and drop out, while a paired
 *  modification contributes both. */
function splitLinesForRows(
  rows: HTMLTableRowElement[],
  changed: ChangedLines,
  side: "old" | "new" | null,
): SelectedLine[] {
  const out: SelectedLine[] = [];
  for (const row of rows) {
    const spans = splitRowSpans(row);
    const oldNum = side === "new" ? undefined : spanLineNum(spans.old);
    const newNum = side === "old" ? undefined : spanLineNum(spans.new);
    if (oldNum !== undefined && changed.deleted.has(oldNum))
      out.push({ side: "old", line: oldNum });
    if (newNum !== undefined && changed.added.has(newNum))
      out.push({ side: "new", line: newNum });
  }
  return out;
}

/** Union of two line selections, deduped by side+line — an additive drag adds
 *  to the committed selection instead of replacing it, and the two can
 *  overlap. */
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

/** A hunk's changed line numbers per side, walking its body from the header's
 *  two starts: added (`+`) new-side numbers and deleted (`-`) old-side ones.
 *  Context advances both sides; an addition advances only the new side and a
 *  deletion only the old. */
function hunkChangedLines(hunk: DiffHunk): {
  added: number[];
  deleted: number[];
} {
  let oldNum = hunkStart(hunk, "old");
  let newNum = hunkStart(hunk, "new");
  const added: number[] = [];
  const deleted: number[] = [];
  for (const line of hunk.text.split("\n").slice(1)) {
    if (line === "" || line.startsWith("\\")) continue; // split artifact / "\ No newline"
    if (line.startsWith("+")) added.push(newNum++);
    else if (line.startsWith("-")) deleted.push(oldNum++);
    else {
      oldNum++;
      newNum++;
    }
  }
  return { added, deleted };
}

/** The new-side line numbers of a hunk's added (`+`) lines. Used to discard a
 *  new file's lines by number; for an all-additions (untracked) hunk this is
 *  every body line. */
function hunkAddedNewLines(hunk: DiffHunk): number[] {
  return hunkChangedLines(hunk).added;
}

/** The selectable line numbers of a whole diff, by side — the `-` lines' old
 *  numbers and the `+` lines' new ones. A split row is classified against these
 *  rather than its own DOM state, which the library owns. */
interface ChangedLines {
  added: Set<number>;
  deleted: Set<number>;
}

function changedLinesOf(diffText: string): ChangedLines {
  const added = new Set<number>();
  const deleted = new Set<number>();
  for (const hunk of parseHunks(diffText).hunks) {
    const lines = hunkChangedLines(hunk);
    for (const n of lines.added) added.add(n);
    for (const n of lines.deleted) deleted.add(n);
  }
  return { added, deleted };
}

interface HunkActionProps {
  hunk: DiffHunk;
  index: number;
  staged: boolean;
  /** A press's own hold: a write from this pane in flight or refreshing. */
  busy: boolean;
  /** The displayed diff trails the text the pane was given. */
  trailing: boolean;
  onHunkAction: (
    hunk: DiffHunk,
    kind: HunkActionKind,
    focus: HunkFocus,
  ) => void;
}

/** Stage + Discard for one hunk, or Unstage alone on a staged diff (whose
 *  Discard would revert the working tree, not the hunk shown), wherever its
 *  host is. The buttons are described by the hunk's line range: their names
 *  repeat on every hunk, and the hosts don't sit in hunk order in the tab
 *  sequence. */
function HunkActionButtons({
  hunk,
  index,
  staged,
  busy,
  trailing,
  onHunkAction,
}: HunkActionProps) {
  const rangeId = useId();
  const held = busy || trailing;
  // A refresh's trail delays the held look, so a fast one never blinks it; the
  // vendored Button transitions everything with no reduced-motion arm, hence
  // the explicit duration. Accepted: ARIA_DISABLED_CLASS drops pointer events
  // at once, so a click in that first 100 ms does nothing, and the stale text
  // would refuse it anyway.
  const heldLook = trailing && !busy && "delay-100 motion-reduce:duration-0";
  const fire = (kind: HunkActionKind) => (e: ReactMouseEvent<HTMLElement>) => {
    // The second click of a double-click is ignored: the hold releases within
    // a double-click's interval, by which time the NEXT hunk's button can sit
    // under the pointer. The click count follows time and distance, not the
    // target; keyboard activation reports 0.
    if (e.detail > 1) return;
    onHunkAction(hunk, kind, {
      index,
      button: e.currentTarget,
      hadFocus: document.activeElement === e.currentTarget,
      // Every hunk discard goes through the confirm.
      viaConfirm: kind === "discard",
    });
  };
  return (
    <>
      {/* `hidden`, not sr-only: the description still resolves for both
          buttons, and browse mode doesn't read the range a third time. */}
      <span id={rangeId} hidden>
        {hunkRangeText(hunk)}
      </span>
      <DisabledReasonButton
        variant="secondary"
        size="xs"
        className={heldLook || undefined}
        disabled={held}
        reason={UPDATING_DIFF_REASON}
        aria-describedby={rangeId}
        data-hunk-primary={index}
        onKeyDown={swallowRepeatedActivation}
        onClick={fire(staged ? "unstage" : "stage")}
      >
        {staged ? "Unstage" : "Stage"} hunk
      </DisabledReasonButton>
      {!staged && (
        <DisabledReasonButton
          variant="ghost"
          size="xs"
          className={cn("text-destructive", heldLook)}
          disabled={held}
          reason={UPDATING_DIFF_REASON}
          aria-describedby={rangeId}
          data-hunk-secondary={index}
          onKeyDown={swallowRepeatedActivation}
          onClick={fire("discard")}
        >
          Discard…
        </DisabledReasonButton>
      )}
    </>
  );
}

/** A hunk's header bar: the pane-top bar of a hunk starting on line 1, and the
 *  inline header a hunk gets once the line above it is expanded into view.
 *  Carries no line-number spans, so the drag-select math reads it as a
 *  separator and a press on it starts no drag: the library's selection manager
 *  (a native listener the mousedown stop can't reach) and our anchor latch
 *  both start only from a line-number cell. */
function HunkHeaderBar({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <code
        className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
        onMouseEnter={clipTitleFromText}
      >
        {label}
      </code>
      {children}
    </div>
  );
}

/**
 * The working-tree diff as ONE whole-file view: content-mode highlighting with
 * collapsible expand, drag the line-number gutter to select lines to stage
 * across the whole file, and per-hunk buttons (Stage + Discard, or Unstage on
 * a staged diff) with one host per hunk (`hunkHost`): overlaid on the `@@` row
 * while the gap above it is collapsed, inline in the library's extend row once
 * the line above shows, or the pane-top bar for a hunk starting on line 1. The
 * library's selection manager drives the drag, but the selection comes from our
 * own row anchors (its range is single-sided by model, and in split can
 * retarget across panes); only a unified Shift drag, which its range already
 * models exactly, rides it. We paint the `gd-line-selected` highlight
 * ourselves — its own class doesn't apply in this standalone setup. Past
 * `STAGING_DIFF_LINE_CAP` it renders whole hunks only until Show full diff; a
 * lone first hunk over the cap is cut short and gets no buttons.
 */
function StagingDiffView({
  repoPath,
  filePath,
  oldPath,
  diffText,
  contentRevs,
  viewMode,
  isDark,
  hunks,
  staged,
  busy,
  frozen,
  selection,
  onSelect,
  onHunkAction,
  hunkFocusRef,
  focusHeld,
  focusSink,
  scrollPaneRef,
  showFull,
  onShowFull,
}: {
  repoPath: string;
  filePath: string;
  /** The old side's path: the diff's rename source, else `filePath`. */
  oldPath: string;
  diffText: string;
  contentRevs: DiffContentRevs;
  viewMode: string;
  isDark: boolean;
  hunks: DiffHunk[];
  staged: boolean;
  busy: boolean;
  /** The parent is keeping this view up past its data: never rebuild it. */
  frozen: boolean;
  selection: SelectedLine[] | null;
  onSelect: (lines: SelectedLine[] | null, forText: string) => void;
  onHunkAction: (
    hunk: DiffHunk,
    kind: HunkActionKind,
    forText: string,
    focus: HunkFocus,
  ) => void;
  /** The button the pending write was fired from; consumed here once the
   *  refreshed hunks are on screen. */
  hunkFocusRef: RefObject<PendingHunkFocus | null>;
  /** The Discard confirm is still closing; its focus return comes first. */
  focusHeld: boolean;
  /** Where focus lands when this view goes while a hunk action's move is
   *  pending: the action left no hunks, or the file left the pane. */
  focusSink: RefObject<HTMLElement | null>;
  /** The scrolling pane this view renders in: in-pane input takes over a
   *  reveal's scroll. */
  scrollPaneRef: RefObject<HTMLDivElement | null>;
  /** Render past the staging cap (Show full diff was pressed for this file). */
  showFull: boolean;
  onShowFull: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const showFullRef = useRef<HTMLButtonElement>(null);
  const { interactive, phase } = useDiffPaneHold();
  const activeRepo = useUiStore((s) => s.repoPath);
  const { syntaxMap, customLanguages } = useEffectiveSyntax(activeRepo);
  const deferredText = useDeferredValue(diffText);
  const deferredPath = useDeferredValue(filePath);
  const deferredOldPath = useDeferredValue(oldPath);
  // The hunks parsed from `deferredText`: both resolve in the same deferred
  // render, so the overlay and its buttons pair with the rows on screen.
  const deferredHunks = useDeferredValue(hunks);
  // The DISPLAY text, capped to whole hunks (until Show full diff) and with
  // over-long lines shortened, so the un-virtualized renderer never freezes
  // (past the mega threshold the whole-file surface takes over). Both keep line
  // numbers, so the FULL `text` still backs every stamp and patch.
  // `displayHunks` (the hunks with rows on screen, the cut one included) is
  // built here so its identity follows the text.
  const live = useMemo(() => {
    const longest = longestLineLength(deferredText);
    const capped = showFull
      ? null
      : capDiffText(deferredText, STAGING_DIFF_LINE_CAP);
    const hidden = capped?.hidden ?? 0;
    const cappedText =
      capped !== null && hidden > 0 ? capped.text : deferredText;
    const wholeHunks =
      capped !== null && hidden > 0 ? capped.wholeHunks : deferredHunks.length;
    const cutHunk = hidden > 0 && capped?.cutHunk === true;
    const short =
      longest <= DIFF_MAX_LINE_CHARS
        ? { text: cappedText, shortened: 0 }
        : shortenLongLines(cappedText, DIFF_MAX_LINE_CHARS);
    return {
      text: deferredText,
      hunks: deferredHunks,
      displayHunks:
        hidden > 0
          ? deferredHunks.slice(0, wholeHunks + (cutHunk ? 1 : 0))
          : deferredHunks,
      longestLine: longest,
      displayText: short.text,
      shortened: short.shortened,
      hidden,
      wholeHunks,
      cutHunk,
    };
  }, [deferredText, deferredHunks, showFull]);
  // Whole-file highlight context + expand, eligible only up to the cap that
  // applies (stagingContentMaxLines), so a capped render is never content mode.
  // `pending` holds the paint so the diff is built once in its final layout.
  const {
    content,
    pending: contentPending,
    hold: contentHold,
    fetching: contentFetching,
  } = useFileContent(
    repoPath,
    deferredPath,
    deferredOldPath,
    deferredText,
    // Shortened hunk text (long lines cut) no longer lines up with the
    // whole-file reads content mode maps syntax onto, and the reads are wasted
    // IPC there — skip content mode once any line is over the shorten cap.
    live.longestLine > DIFF_MAX_LINE_CHARS ? undefined : contentRevs,
    stagingContentMaxLines(showFull),
    frozen,
  );
  // ONE retained unit under one predicate: through a refresh's hold or a first
  // whole-file read (Show full diff's included), the rows, hunks, counts, the
  // text a click carries, and the build and worker highlighting below all stay
  // as painted; the parent refuses a click once its live text moves past it. A
  // HELD slot keeps it too, so reads under the dim never rebuild it (only
  // "held": a preparing slot is non-interactive too but must build).
  const readsHold = contentHold || contentPending;
  const holdingBuild = readsHold || phase === "held";
  const {
    text: shownText,
    hunks: viewHunks,
    displayHunks,
    displayText,
    shortened,
    hidden,
    wholeHunks,
  } = useRetained(live, !holdingBuild);
  // The buttons hold until the display has caught up with the text the parent
  // released them for, not only until that text arrives.
  const trailing = shownText !== diffText;
  const held = busy || trailing;
  // A Show full diff press whose focus move waits for the full build's hosts
  // (see the reveal landing below). Armed only by a press that had focus. While
  // armed it follows the user's own focus moves: onto a hunk button of this
  // diff, the move retargets to that hunk's same button in the new build; back
  // onto Show full diff, to the first revealed hunk; anywhere else, or a
  // pointer press, is the user taking over and disarms it.
  const revealRef = useRef<{
    focus: HunkFocus;
    control: HunkControl;
    /** The press itself: Show full diff and the first revealed hunk. */
    origin: { index: number; button: HTMLElement };
    /** A target this view is focusing, whose focusin is not a user move. */
    landing: HTMLElement | null;
    /** The build the move waits to see replaced: the one pressed on, then the
     *  one it landed in while the whole-file reads can still rebuild it. */
    from: DiffFile | null;
    landed: boolean;
    /** The user moved the pane while armed: its landings stop scrolling. */
    tookOver: boolean;
  } | null>(null);
  const disarmRevealRef = useRef<(() => void) | null>(null);
  const disarmReveal = useCallback(() => disarmRevealRef.current?.(), []);
  const armReveal = useCallback(
    (focus: HunkFocus, from: DiffFile | null) => {
      disarmRevealRef.current?.();
      revealRef.current = {
        focus,
        control: "primary",
        origin: { index: focus.index, button: focus.button },
        landing: null,
        from,
        landed: false,
        tookOver: false,
      };
      // Input anywhere in the scrolling pane moves it, the hint strip and the
      // footer included, so containment is judged against the pane.
      const inScrollPane = (target: EventTarget | null) =>
        target instanceof Node &&
        (scrollPaneRef.current?.contains(target) ?? false);
      const latch = (e: Event) => {
        const reveal = revealRef.current;
        if (reveal !== null && inScrollPane(e.target)) reveal.tookOver = true;
      };
      const latchKey = (e: KeyboardEvent) => {
        if (PANE_SCROLL_KEYS.has(e.key)) latch(e);
      };
      const onFocusIn = (e: FocusEvent) => {
        const reveal = revealRef.current;
        const moved = e.target;
        if (
          reveal === null ||
          moved === reveal.landing ||
          moved === reveal.focus.button
        )
          return;
        if (moved === reveal.origin.button) {
          reveal.focus = { ...reveal.focus, ...reveal.origin };
          reveal.control = "primary";
          return;
        }
        const container = containerRef.current;
        const hit =
          moved instanceof Element && container?.contains(moved)
            ? hunkControlOf(moved)
            : null;
        if (hit === null) {
          disarm();
          return;
        }
        reveal.focus = {
          ...reveal.focus,
          index: hit.index,
          button: hit.button,
        };
        reveal.control = hit.control;
      };
      const disarm = () => {
        revealRef.current = null;
        disarmRevealRef.current = null;
        document.removeEventListener("pointerdown", disarm, true);
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("wheel", latch, true);
        document.removeEventListener("touchmove", latch, true);
        document.removeEventListener("keydown", latchKey, true);
      };
      const latchOptions = { capture: true, passive: true };
      document.addEventListener("pointerdown", disarm, true);
      document.addEventListener("focusin", onFocusIn, true);
      document.addEventListener("wheel", latch, latchOptions);
      document.addEventListener("touchmove", latch, latchOptions);
      document.addEventListener("keydown", latchKey, latchOptions);
      disarmRevealRef.current = disarm;
    },
    [scrollPaneRef],
  );
  const onDisplayedHunkAction = useCallback(
    (hunk: DiffHunk, kind: HunkActionKind, focus: HunkFocus) => {
      // A hunk press is newer intent than a pending reveal.
      disarmReveal();
      onHunkAction(hunk, kind, shownText, focus);
    },
    [onHunkAction, shownText, disarmReveal],
  );
  // The hunk a hunk action's focus last landed on, re-landable while armed
  // (see the re-land effect below). A pointer press or a fresh key press is the
  // user taking over; a held key's auto-repeats are not, since the press that
  // landed focus is still down. Past the bound, a remount is no longer this
  // action's. A re-land scrolls only for a write's record (`cycle`) that the
  // user hasn't taken over, read at the scroll; without one it never scrolls.
  const relandRef = useRef<{
    index: number;
    button: HTMLElement;
    control: HunkControl;
    cycle: { readonly tookOver: boolean } | undefined;
  } | null>(null);
  const disarmRef = useRef<(() => void) | null>(null);
  const disarmReland = useCallback(() => disarmRef.current?.(), []);
  const armReland = useCallback(
    (
      index: number,
      button: HTMLElement,
      control: HunkControl = "primary",
      cycle?: { readonly tookOver: boolean },
    ) => {
      disarmRef.current?.();
      relandRef.current = { index, button, control, cycle };
      let timer = 0;
      const disarm = () => {
        relandRef.current = null;
        disarmRef.current = null;
        window.clearTimeout(timer);
        document.removeEventListener("pointerdown", disarm, true);
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (e: KeyboardEvent) => {
        if (!e.repeat) disarm();
      };
      timer = window.setTimeout(disarm, RELAND_BOUND_MS);
      document.addEventListener("pointerdown", disarm, true);
      document.addEventListener("keydown", onKey, true);
      disarmRef.current = disarm;
    },
    [],
  );
  useEffect(() => disarmReland, [disarmReland]);
  // `blocked` is omitted: a mega-line file never reaches this view —
  // WorkingTreeDiff routes it to the whole-file DiffSurface fallback first.
  const { holdForGrammar, grammarState, workerHighlighter } = useShikiRouting({
    filePath: deferredPath,
    text: displayText,
    content: content ?? null,
    contentPending: holdingBuild,
    syntaxMap,
    customLanguages,
  });
  // The diff as displayed, built from the DISPLAY text (the full text still
  // backs every stage/unstage/discard patch; see WorkingTreeDiff). Null while
  // the build is held, so arriving reads never restructure an intermediate
  // build (the retained one stays painted), and in the pass where the retained
  // text lags `live`, which React discards, so a build there is wasted work.
  // grammarState: inert once compiled; see useShikiRouting's contract.
  // biome-ignore lint/correctness/useExhaustiveDependencies: grammarState stays listed for the uncompiled path; the rebuild rides holdForGrammar
  const builtDiffFile = useMemo(() => {
    if (holdingBuild || holdForGrammar || displayText !== live.displayText)
      return null;
    const file = createDiffFile(
      deferredPath,
      displayText,
      { syntaxMap, customLanguages },
      content ?? undefined,
    );
    // Rows prebuilt for both layouts, as the library's own mount effect builds
    // them: its view remounts on every rebuild, and rows built only in that
    // effect would leave the pane empty for a commit, which clamps its scroll
    // to the top. The layout stays out of the deps, since a new build would
    // drop the user's expanded context.
    file?.buildSplitDiffLines();
    file?.buildUnifiedDiffLines();
    return file;
  }, [
    deferredPath,
    displayText,
    live.displayText,
    syntaxMap,
    customLanguages,
    content,
    holdingBuild,
    holdForGrammar,
    grammarState,
  ]);
  const diffFile = useRetained(builtDiffFile, !holdingBuild);
  const shownHighlighter = useRetained(workerHighlighter, !holdingBuild);
  // A hold over a view that never built (a cold mount's first reads, or a
  // grammar that was still loading) has nothing to keep, so it renders nothing.
  // A held slot with no build keeps its "No changes" placeholder instead.
  const holdBlank = readsHold && diffFile === null;

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
  const split = viewMode === "split";
  const splitRef = useLatestRef(split);
  // A split drag crosses whole rows, so each side of a crossed row is classified
  // against the diff's own `-`/`+` numbers: context and expanded context sit in
  // neither set. Keyed on the retained FULL `shownText`: the `displayText` rows
  // keep its line numbers (shortenLongLines preserves count and numbering, and
  // the cap only drops trailing lines), so every rendered row classifies the
  // same. The parent's `hunks` prop tracks the LIVE text, which can lead the
  // deferred rows, so reusing it would misclassify in that window.
  const changed = useMemo(() => changedLinesOf(shownText), [shownText]);

  // Inline hunk headers ride the library's extend rows. Both props reach its
  // store in a passive effect, so everything a header shows (the hunks, held,
  // staged, the action) changes their identity; a ref-stable renderer would
  // freeze the headers on stale state. Always an object: the view applies an
  // undefined `extendData` as "no change", keeping stale entries.
  const extendData = useMemo(
    () => hunkHeaderExtendData(displayHunks, split),
    [displayHunks, split],
  );
  // Buttons only on hunks wholly on screen: a hunk the cap cut short shows none
  // until Show full diff, so no action touches lines the user can't see.
  const renderExtendLine = useCallback(
    ({ data }: { data: HunkHeaderData }) => {
      const hunk = displayHunks[data.hunk];
      if (!hunk) return null;
      const r = hunkRange(hunk);
      if (data.side === "old")
        return <HunkHeaderBar label={`-${r.oldStart},${r.oldLines}`} />;
      return (
        <HunkHeaderBar
          label={split ? `+${r.newStart},${r.newLines}` : hunk.header}
        >
          {data.hunk < wholeHunks && (
            <HunkActionButtons
              hunk={hunk}
              index={data.hunk}
              staged={staged}
              busy={busy}
              trailing={trailing}
              onHunkAction={onDisplayedHunkAction}
            />
          )}
        </HunkHeaderBar>
      );
    },
    [
      displayHunks,
      wholeHunks,
      split,
      staged,
      busy,
      trailing,
      onDisplayedHunkAction,
    ],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !diffFile) return;
    // The drag's two anchor rows. The library's range is pinned to the side the
    // drag started on and its end sticks at the last row bearing a number there,
    // so the end anchor is tracked below instead. Effect-scoped: the drag dies
    // with the manager it belongs to.
    let drag: DragAnchors | null = null;
    // The latch that licenses anchor minting. Gutter ancestry is what lets
    // the manager start a selection at all; the primary-button clause then
    // scopes the two-sided span deliberately — a non-primary gutter drag
    // keeps the library's single-sided range. Absent the latch a mint is
    // declined: either that non-primary drag, or a stranded drag's range
    // still emitting after a lost mouseup.
    let pressed = false;
    // Shift scopes a drag to the side it started on. Unified hands that to the
    // library's own range; split must anchor instead, because the library's
    // split mouseover reads the line number from whichever PANE the cursor is
    // over while keeping the start side, so a drift across the gutter would
    // extend the range with the other pane's numbering. Read at mousedown
    // alongside the additive modifier: mid-drag key changes are ignored.
    let shifted = false;
    const onMouseDownCapture = (e: MouseEvent) => {
      additiveRef.current = isAdditiveDrag(e);
      shifted = e.shiftKey;
      // A mouseup lost to a focus steal would strand the last drag's anchors;
      // capture precedes the manager's mousedown, so every press re-anchors.
      drag = null;
      pressed =
        e.button === 0 &&
        e.target instanceof Element &&
        !!e.target.closest(GUTTER_CELL);
    };
    container.addEventListener("mousedown", onMouseDownCapture, true);
    // An additive drag paints over the committed selection; a plain one replaces
    // it, so its base is empty (the pre-additive behavior).
    const paintBase = () =>
      additiveRef.current ? (selectedRef.current ?? []) : [];
    const onMouseOver = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      // No button held: drop the latch, and if a stranded drag left its span
      // painted, restore the committed paint — this stops OUR two-sided span
      // from following the cursor or re-anchoring; the library's own stranded
      // range still repaints single-sided via paintRange (pre-existing).
      if ((e.buttons & 1) === 0) {
        if (drag) {
          drag = null;
          paintLines(container, selectedRef.current ?? [], split);
        }
        pressed = false;
        return;
      }
      if (!drag) return;
      // A unified row keeps both numbers in the one gutter cell, so only that
      // cell identifies the row under the cursor. A split row splits them across
      // four cells and shows a placeholder where a side is empty, so any cell of
      // the row serves — a gutter-only test would stall the span on a pure
      // addition or deletion.
      const row = split
        ? e.target.closest("tr")
        : e.target.closest(".diff-line-num")?.closest("tr");
      if (!row) return;
      // mouseover fires per descendant entered (the gutter cell and its number
      // spans fire separately), so same-row is the common case — skip its repaint.
      if (row === drag.endRow) return;
      const { old: oldNum, new: newNum } = rowLineNumbers(row, split);
      if (oldNum === undefined && newNum === undefined) return; // separator row
      drag.endRow = row;
      paintRowSpan(container, drag, paintBase(), split);
    };
    container.addEventListener("mouseover", onMouseOver);
    const manager = createDiffMultiSelectManager(container, diffFile, {
      isUnifiedMode: !split,
      onSelectionChange: (range) => {
        // A null range is the manager clearing itself (teardown). Anchors mint
        // only under a live press — a stranded drag's library range keeps
        // emitting after a lost mouseup and must not re-create what the hover
        // guard cleared — and only where they beat that range: everywhere but a
        // unified Shift drag, whose mouseover refuses rows without a start-side
        // number and so can't retarget. The range's side at mint time is the
        // side pressed, which is what a Shift drag scopes itself to.
        if (!range) drag = null;
        else if (!drag && pressed && (!shifted || split)) {
          const row = rowForLine(container, range.side, range.startLineNumber);
          if (row)
            drag = {
              startRow: row,
              endRow: row,
              side: shifted ? range.side : null,
            };
        }
        if (drag) {
          paintRowSpan(container, drag, paintBase(), split);
          return;
        }
        paintRange(container, range, paintBase(), split);
      },
      onSelectionComplete: (result) => {
        // Anchors give the rows the drag actually crossed, and both their sides
        // unless Shift scoped it — the library's range is single-sided by model,
        // so it drops the opposite side's lines. It stands in where no anchors
        // exist: a unified Shift drag, a non-primary one, or a drag whose anchor
        // has left the DOM.
        const rows = drag
          ? rowsBetween(container, drag.startRow, drag.endRow)
          : [];
        const dragSide = drag?.side ?? null;
        drag = null;
        pressed = false;
        let lines: SelectedLine[];
        if (rows.length) {
          lines = split
            ? splitLinesForRows(rows, changed, dragSide)
            : linesForRows(rows);
        } else {
          lines = (result?.lines ?? [])
            .filter((l) => l.isAdd || l.isDelete)
            .map(
              (l): SelectedLine => ({
                side: l.isAdd ? "new" : "old",
                line: l.lineNumber,
              }),
            );
        }
        const next = additiveRef.current
          ? mergeSelection(selectedRef.current, lines)
          : lines;
        // Paint the outcome now — a null commit over an already-null selection
        // re-renders nothing and would strand the drag tint. If the text moved
        // mid-drag this tints briefly; the manager effect's re-run clears it.
        paintLines(container, next, split);
        // Stamp against the text these rows were BUILT from — the live
        // diff.data.text can already be newer while the deferred render lags.
        onSelectRef.current(next.length ? next : null, shownText);
      },
    });
    paintLines(container, selectedRef.current ?? [], split); // re-assert after (re)mount
    return () => {
      container.removeEventListener("mousedown", onMouseDownCapture, true);
      container.removeEventListener("mouseover", onMouseOver);
      manager.destroy();
    };
  }, [diffFile, split, shownText, changed]);

  // Paint the committed selection from state (incl. cleared → []).
  useEffect(() => {
    const container = containerRef.current;
    if (container) paintLines(container, selection ?? [], split);
  }, [selection, split]);

  // Host each hunk's buttons from that hunk's OWN first row (found by line
  // number), NOT from the Nth `@@` marker row: in content mode those rows mark
  // collapsed gaps, not hunks 1:1 (a change at line 1 has no leading gap → no
  // marker), and expanding moves or removes them. The row directly above the
  // first row decides the host (see `hunkHost`); an overlay lives inside the
  // scrolled content, so it tracks scroll without a listener. Re-measure only on
  // rebuild/expand/collapse/resize. A rebuild's rows come prebuilt with it, so
  // its own measure finds them; a later mutation's measure (an expand, the
  // Collapse bar) commits in the same task as the rows it moved (see the
  // MutationObserver below), so those rows never paint apart from their buttons.
  const [measured, setMeasured] = useState<{
    forFile: DiffFile | null;
    forHunks: DiffHunk[] | null;
    list: { top: number; host: HunkHost }[];
  }>({ forFile: null, forHunks: null, list: [] });
  // The settle report, the hosts and the overlay positions all read this list,
  // stamped with the diffFile and hunks measured: positions measured for other
  // rows put live buttons on wrong lines, so they hide until a re-measure. A
  // superseded effect's observer can still measure before its cleanup runs,
  // but it stamps only its own old identity, which this check rejects.
  const anchors =
    measured.forFile === diffFile && measured.forHunks === displayHunks
      ? measured.list
      : [];
  // The container's height at its last measure with rows on screen: the floor
  // the rowless hold below keeps while a rebuild's rows are pending.
  const heightRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !diffFile) return;
    let raf = 0;
    // Whether this build's rows have had the selection's tint put back: the
    // manager effect's own re-assert can run before the library's rows exist,
    // and only this identity's first measure with rows may repaint, since a
    // later re-measure (resize, mutation) would wipe a live drag's tint.
    let tinted = false;
    // A build carries its rows prebuilt (see `builtDiffFile`), so this effect's
    // own measure normally finds them; rows the library still inserts late are
    // measured again by the mutation that inserts them. Hunks past the cap have
    // no rows, so only `displayHunks` are measured.
    const measure = () => {
      const rootTop = container.getBoundingClientRect().top;
      const list = displayHunks.map((h, i) => {
        const row = hunkFirstRow(container, h);
        if (!row) return { top: -1, host: "none" as const };
        const prev = row.previousElementSibling;
        const host = hunkHost(prev?.getAttribute("data-state"), i);
        // An overlay sits on the `@@` row; the other hosts are in flow, so
        // only whether the row was found matters.
        const anchor = host === "row" && prev ? prev : row;
        return { top: anchor.getBoundingClientRect().top - rootTop, host };
      });
      if (list.some((a) => a.top >= 0))
        heightRef.current = container.offsetHeight;
      const rowless =
        diffRendersRows(diffFile) &&
        list.length > 0 &&
        list.every((a) => a.top < 0);
      if (!rowless && !tinted) {
        tinted = true;
        paintLines(container, selectedRef.current ?? [], splitRef.current);
      }
      setMeasured((prev) => {
        const same =
          prev.forFile === diffFile && prev.forHunks === displayHunks;
        // A new identity measured rowless stays unstamped until its rows land
        // (the stamp check already hides the old list); the same identity gone
        // rowless stamps, hiding its buttons.
        if (rowless && !same) return prev;
        // An unchanged measure keeps the previous state so React bails out: the
        // overlay's own insertion is a mutation that measures again.
        return same &&
          prev.list.length === list.length &&
          prev.list.every(
            (a, i) => a.top === list[i].top && a.host === list[i].host,
          )
          ? prev
          : { forFile: diffFile, forHunks: displayHunks, list };
      });
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    // Resize fires continuously while the pane is resized, so it coalesces to
    // one measure per frame and the buttons trail a resize by a frame.
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    // Mutation callbacks run as a microtask after the commit that changed the
    // rows (a rebuild, an expand, the Collapse bar mounting), outside React's
    // render and commit, so a measure flushed here paints with those rows; a rAF
    // measure can land a frame after them.
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      flushSync(measure);
    });
    mo.observe(container, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [diffFile, displayHunks]);

  // Hunk 0's measure, once one of THIS diffFile has found its row.
  const firstMeasured = anchors[0];
  const firstFound = firstMeasured !== undefined && firstMeasured.top >= 0;

  // A pending focus move ends with this view. A hunk action that left no
  // hunks, or took the file out of the pane, unmounts it along with the pressed
  // button, so the move lands on the pane's sink (under the same rule as any
  // landing); anywhere else (Preview, a file switch) it is dropped by that rule.
  // Declared before the layout-switch drop below: cleanups run in order.
  useEffect(
    () => () => {
      const pending = hunkFocusRef.current;
      hunkFocusRef.current = null;
      if (pending === null) return;
      const land = () => landHunkFocus(pending, focusSink.current);
      if (!pending.viaConfirm) land();
      // A frame past the confirm's unmount, so the move lands after its return.
      else requestAnimationFrame(land);
    },
    [hunkFocusRef, focusSink],
  );
  // A layout switch drops a pending move: the buttons it would land on are not
  // the ones the press saw.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a layout switch is the trigger
  useEffect(
    () => () => {
      hunkFocusRef.current = null;
    },
    [split, hunkFocusRef],
  );
  // A built diff whose rows this view hasn't measured yet: the negation of the
  // settle report's rows term below, over the same stamped `anchors`.
  const rowsPending =
    diffFile !== null &&
    diffRendersRows(diffFile) &&
    !anchors.some((a) => a.top >= 0);
  // A rebuild that commits with no rows in the DOM keeps the container at its
  // last measured height, so the pane can't shrink and clamp its scroll to the
  // top; prebuilt rows need no hold. Written imperatively because the height is
  // a ref (never read in render), so this div must never take a `style` prop:
  // React would clobber the value. Declared before the landing, which scrolls.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const hold =
      rowsPending &&
      heightRef.current > 0 &&
      !displayHunks.some((h) => hunkFirstRow(container, h) !== null);
    container.style.minHeight = hold ? `${heightRef.current}px` : "";
  }, [rowsPending, displayHunks]);
  // Once the hold releases and the refreshed hunks have hosts, focus moves to
  // the Stage/Unstage of the hunk now at the press's index (or the last hunk);
  // `landHunkFocus` decides whether it moves at all. Past a capped diff's
  // last whole hunk it lands on Show full diff instead, scrolled into view
  // unless the user took over; that stable node arms no re-land. A pending
  // reveal is newer intent: this waits.
  useLayoutEffect(() => {
    const pending = hunkFocusRef.current;
    const container = containerRef.current;
    if (pending === null || held || focusHeld || !container) return;
    if (revealRef.current !== null || anchors.length === 0) return;
    if (hidden > 0 && pending.index >= wholeHunks) {
      hunkFocusRef.current = null;
      const footer = showFullRef.current;
      const landFooter = () => {
        if (footer === null || !landHunkFocus(pending, footer)) return;
        if (!pending.tookOver) footer.scrollIntoView({ block: "nearest" });
      };
      if (!pending.viaConfirm) landFooter();
      // A frame past the confirm's unmount, so the move lands after its return.
      else requestAnimationFrame(landFooter);
      return;
    }
    const index = Math.min(pending.index, displayHunks.length - 1);
    const target = primaryFor(container, index);
    if (target === undefined) {
      // That hunk has no host on screen yet (an inline header trails the
      // measure by a passive commit): a re-measure lands it, and two frames
      // without one drop the move rather than send focus elsewhere.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (hunkFocusRef.current === pending) hunkFocusRef.current = null;
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    hunkFocusRef.current = null;
    const land = () => {
      if (!landHunkFocus(pending, target)) return;
      // The focus moved without scrolling, and the rebuild can leave the target
      // off screen. Once the user has moved the pane (`tookOver`, read at each
      // scroll), neither this landing nor its re-land scrolls.
      if (!pending.tookOver) target.scrollIntoView({ block: "nearest" });
      armReland(index, target, "primary", pending);
    };
    if (!pending.viaConfirm) land();
    // A frame past the confirm's unmount, so the move lands after its return.
    else requestAnimationFrame(land);
  }, [
    held,
    focusHeld,
    anchors,
    displayHunks,
    hidden,
    wholeHunks,
    hunkFocusRef,
    armReland,
  ]);
  // After Show full diff, once a build other than the one pressed on measures
  // its hosts, focus goes to the first revealed hunk's Stage/Unstage (or the
  // hunk button the user moved to), clamped like the post-write landing and
  // scrolled into view unless the user took over; it lands again on each
  // rebuild while the reads run. A held slot, or no host two frames past a
  // measure, sends it to the sink. `landHunkFocus` gates every move.
  const readsBusy = contentFetching || readsHold;
  useLayoutEffect(() => {
    const reveal = revealRef.current;
    const container = containerRef.current;
    if (reveal === null || !container) return;
    if (diffFile === null || diffFile === reveal.from) {
      if (reveal.landed && !readsBusy) disarmReveal();
      return;
    }
    if (anchors.length === 0) return;
    const toSink = () => {
      if (revealRef.current !== reveal) return;
      disarmReveal();
      landHunkFocus(reveal.focus, focusSink.current);
    };
    if (!interactive) {
      toSink();
      return;
    }
    const index = Math.min(reveal.focus.index, displayHunks.length - 1);
    const control = reveal.control;
    const target = hunkControlFor(container, index, control);
    if (target === undefined) {
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(toSink);
      });
      return () => cancelAnimationFrame(frame);
    }
    reveal.landing = target;
    const moved = landHunkFocus(reveal.focus, target);
    reveal.landing = null;
    if (!moved) {
      disarmReveal();
      return;
    }
    if (!reveal.tookOver) target.scrollIntoView({ block: "nearest" });
    armReland(index, target, control);
    if (!readsBusy) {
      disarmReveal();
      return;
    }
    reveal.focus = { ...reveal.focus, index, button: target };
    reveal.from = diffFile;
    reveal.landed = true;
  }, [
    diffFile,
    anchors,
    displayHunks,
    readsBusy,
    interactive,
    focusSink,
    armReland,
    disarmReveal,
  ]);
  // A reveal still pending when this view goes lands on the sink, under the
  // same rule as any landing: an external change can replace the slot while
  // focus sits on the held Show full diff.
  useEffect(
    () => () => {
      const reveal = revealRef.current;
      disarmReveal();
      if (reveal !== null) landHunkFocus(reveal.focus, focusSink.current);
    },
    [disarmReveal, focusSink],
  );
  // A landed focus can lose its button to a later rebuild: the whole-file
  // content read and the diff read can land in separate renders, and the
  // second remounts every host. While armed, focus that fell to <body> from the
  // detached button goes back to the same hunk's same button; focus anywhere
  // else is the user's. Checked every commit, since any commit can remount.
  useLayoutEffect(() => {
    const landed = relandRef.current;
    const container = containerRef.current;
    if (landed === null || landed.button.isConnected || !container) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      disarmReland();
      return;
    }
    const target = hunkControlFor(container, landed.index, landed.control);
    if (target === undefined) return;
    target.focus({ preventScroll: true });
    if (landed.cycle !== undefined && !landed.cycle.tookOver)
      target.scrollIntoView({ block: "nearest" });
    landed.button = target;
  });
  // Settled once this build's rows are measured: they come prebuilt with it,
  // but the stamp lands with the measure, and rows the library inserts late
  // must not settle a rowless paint. A diff with no hunk lines never gets a
  // row, so it settles at build. A retained build on screen
  // counts through its whole-file reads (Show full diff's included), so a move
  // then holds it; with nothing retained, `holdBlank` keeps it unsettled.
  useReportPaneSettled(
    !holdForGrammar &&
      !holdBlank &&
      (diffFile === null ||
        !diffRendersRows(diffFile) ||
        anchors.some((a) => a.top >= 0)),
  );

  // The single-paint gate: while a lazy Shiki grammar loads, or a cold mount's
  // whole-file reads settle with no build retained, render nothing rather than
  // a diff we'd restructure or re-highlight. It precedes the empty placeholder
  // so loading never reads as "No changes to show"; the effects above guard on
  // `!diffFile`, so they no-op while blank and re-bind on the single build.
  if (holdForGrammar || holdBlank) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  // A line-1 hunk has nothing above it to host its buttons — the pane-top bar
  // instead, labeled with the hunk's own header even when the cap cut it short
  // (then without buttons). Predicted from the hunk so it paints with the first
  // rows; a measure of this diffFile then wins.
  const firstNeedsHeader =
    !!viewHunks[0] &&
    (firstFound
      ? firstMeasured.host === "top"
      : !firstHunkHasSepRow(viewHunks[0]));
  const onShowFullClick = (e: ReactMouseEvent<HTMLElement>) => {
    // The second click of a double-click is ignored, as on the hunk buttons:
    // the full diff can rebuild under the pointer within its interval.
    if (e.detail > 1) return;
    // The newer intent: a pending post-write landing never contends with it.
    hunkFocusRef.current = null;
    if (document.activeElement === e.currentTarget)
      armReveal(
        {
          index: wholeHunks,
          button: e.currentTarget,
          hadFocus: true,
          viaConfirm: false,
        },
        diffFile,
      );
    onShowFull();
  };
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
              collapseAllContext(diffFile);
              setExpanded(false);
            }}
          >
            Collapse expanded context
          </Button>
        </div>
      )}
      {firstNeedsHeader && (
        <HunkHeaderBar label={viewHunks[0].header}>
          {wholeHunks > 0 && (
            <HunkActionButtons
              hunk={viewHunks[0]}
              index={0}
              staged={staged}
              busy={busy}
              trailing={trailing}
              onHunkAction={onDisplayedHunkAction}
            />
          )}
        </HunkHeaderBar>
      )}
      <DiffView<HunkHeaderData>
        diffFile={diffFile}
        // Worker ASTs land as a highlighter PROP, not a rebuild: the view's
        // effect applies them to its own clone, so expansion state survives.
        registerHighlighter={shownHighlighter}
        diffViewMode={
          viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified
        }
        diffViewTheme={isDark ? "dark" : "light"}
        diffViewHighlight
        diffViewWrap
        diffViewFontSize={12}
        extendData={extendData}
        renderExtendLine={renderExtendLine}
      />
      {anchors.map((a, i) =>
        displayHunks[i] && i < wholeHunks && a.host === "row" && a.top >= 0 ? (
          // Buttons sit ON the `@@` separator row (never on code), right-aligned
          // to clear the native expand controls. A press here can't start a
          // drag: see HunkHeaderBar.
          <div
            key={`${i}:${displayHunks[i].header}`}
            className="absolute right-3 z-10 flex -translate-y-px gap-1"
            style={{ top: a.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HunkActionButtons
              hunk={displayHunks[i]}
              index={i}
              staged={staged}
              busy={busy}
              trailing={trailing}
              onHunkAction={onDisplayedHunkAction}
            />
          </div>
        ) : null,
      )}
      {/* After the rows in DOM order, so Tab from the last visible hunk's
          buttons reaches Show full diff. Held like the hunk buttons, and
          through a first whole-file read, so a repeat press can't rebuild a
          view mid-hold. */}
      <DiffCapFooter
        hidden={hidden}
        shortened={shortened}
        onShowFull={onShowFullClick}
        onButtonKeyDown={swallowRepeatedActivation}
        held={held || contentPending}
        heldReason={UPDATING_DIFF_REASON}
        buttonRef={showFullRef}
      />
    </div>
  );
}
