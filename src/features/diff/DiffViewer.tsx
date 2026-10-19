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
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";
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
import {
  DiffPaneHold,
  type DiffPaneHoldValue,
  useDiffPaneHold,
  useReportPaneSettled,
} from "./diff-pane-hold";
import {
  answeredSince,
  answerMark,
  expirePane,
  filePaneView,
  HOLD_BOUND_MS,
  isHolding,
  type PaneView,
  paneSlots,
  paneViewKey,
  retargetPane,
  type SlotPhase,
  settlePane,
  startPaneHold,
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
  // out of sight, clipped over it, so a click swaps the pane once (see
  // diff-pane-slots.ts).
  const [storedHold, setHold] = useState(() => startPaneHold(target));
  const hold = retargetPane(storedHold, target);
  if (hold !== storedHold) setHold(hold);
  const holding = isHolding(hold);
  const preparingKey =
    holding && hold.target.kind === "file" ? hold.target.key : null;
  useEffect(() => {
    if (preparingKey === null) return;
    const bound = window.setTimeout(
      () => setHold((h) => expirePane(h, preparingKey)),
      HOLD_BOUND_MS,
    );
    return () => window.clearTimeout(bound);
  }, [preparingKey]);
  const onSlotSettled = useCallback(
    (key: string, repo: string, settled: boolean) =>
      setHold((h) => settlePane(h, key, repo, settled)),
    [],
  );
  // Focus inside a slot that turns held lands here rather than on <body>. A
  // sibling of the slots, never an ancestor: a focusable ancestor would take
  // focus on every click into the code and swallow keyboard scrolling.
  const focusSinkRef = useRef<HTMLSpanElement>(null);

  const renderView = (view: PaneView<SelectedFile>) => {
    if (view.kind === "file") {
      return (
        <WorkingTreeDiff
          repoPath={view.repo}
          file={view.file}
          focusSink={focusSinkRef}
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
  };

  return (
    // The busy signal lives here: both slots are inert while holding, and an
    // inert subtree is out of the accessibility tree along with its aria-busy.
    <div className="relative h-full" aria-busy={holding || undefined}>
      <span ref={focusSinkRef} tabIndex={-1} className="sr-only" />
      {paneSlots(hold).map(({ view: slotView, phase }) => {
        // A held slot paints what it settled with; the live slot takes this
        // render's target (same key, but the selection's freshest object).
        const view = phase === "held" ? slotView : target;
        return view.kind === "file" ? (
          <FileSlot
            key={paneViewKey(view)}
            slotKey={view.key}
            repo={view.repo}
            phase={phase}
            onSettled={onSlotSettled}
            focusRescue={focusSinkRef}
          >
            {renderView(view)}
          </FileSlot>
        ) : (
          <PaneFrame key={paneViewKey(view)} held={phase === "held"}>
            {renderView(view)}
          </PaneFrame>
        );
      })}
    </div>
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

const SLOT_FRAME_CLASS: Record<SlotPhase, string> = {
  shown: "h-full",
  held: "h-full",
  // Stacked over the held slot (absolute, rendered after it) at full size, so
  // container queries, the split/unified measure and row measurement are final
  // before it shows. Hidden by a full clip, never `invisible`: the vendored
  // Button's transition-all animates inherited visibility, so its buttons would
  // paint a frame late at promotion. Never opacity either: the frame's
  // PLACEHOLDER_FADE would fade the slot in instead of showing it at once.
  preparing: "absolute inset-0 [clip-path:inset(50%)]",
};

/** The no-file placeholder or a conflict view. Only the placeholder is ever
 *  held (a first selection prepares out of sight, clipped over it), and
 *  undimmed: it isn't content. */
function PaneFrame({ held, children }: { held: boolean; children: ReactNode }) {
  return (
    <div className="h-full" inert={held}>
      {children}
    </div>
  );
}

/**
 * One file's slot. Its surfaces report their loading gates here; the slot is
 * settled once at least one gate has reported and every reported gate is
 * settled, and it reports each change of that state up: settling promotes it
 * while it is the preparing target, and either edge updates the shown file's
 * settle. A render-null arm that never reports is invisible to that check, so
 * each one reports. Held and preparing slots are inert and non-interactive.
 */
function FileSlot({
  slotKey,
  repo,
  phase,
  onSettled,
  focusRescue,
  children,
}: {
  slotKey: string;
  repo: string;
  phase: SlotPhase;
  onSettled: (key: string, repo: string, settled: boolean) => void;
  focusRescue: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [gates, setGates] = useState<ReadonlyMap<object, boolean>>(
    () => new Map(),
  );
  // Stable on purpose: every gate's layout effect depends on it, so a fresh
  // function per render would re-register them all in a loop.
  const reportSettled = useCallback((settled: boolean) => {
    const gate = {};
    setGates((prev) => new Map(prev).set(gate, settled));
    return () =>
      setGates((prev) => {
        const next = new Map(prev);
        next.delete(gate);
        return next;
      });
  }, []);
  const settled = gates.size > 0 && Array.from(gates.values()).every(Boolean);
  // Both edges: a shown slot that goes loading again (Raw to Preview, a
  // rebuild's measure gap) must not be held by the next click.
  useLayoutEffect(() => {
    onSettled(slotKey, repo, settled);
  }, [settled, slotKey, repo, onSettled]);
  // `inert` blurs a focused descendant to <body> after this commit; hand focus
  // to the pane's sink first.
  useLayoutEffect(() => {
    if (phase === "held" && frameRef.current?.contains(document.activeElement))
      focusRescue.current?.focus({ preventScroll: true });
  }, [phase, focusRescue]);
  // Memoized for identity: the context reaches every gate in the slot.
  const hold = useMemo<DiffPaneHoldValue>(
    () => ({ interactive: phase === "shown", reportSettled }),
    [phase, reportSettled],
  );
  return (
    <div
      ref={frameRef}
      className={cn(
        SLOT_FRAME_CLASS[phase],
        PLACEHOLDER_FADE,
        // The delay keeps a fast swap from flashing a half-dimmed pane.
        phase === "held" && "opacity-80 delay-100",
      )}
      inert={phase !== "shown"}
    >
      <DiffPaneHold value={hold}>{children}</DiffPaneHold>
    </div>
  );
}

type HunkActionKind = "stage" | "unstage" | "discard";

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
  // A write from this pane, from the press until the reads it changed have
  // answered again: `settled` is null while the write runs, then holds the
  // answer marks the reads' cache entries showed at the settle. Pressing sets
  // it too, since `isPending` reaches render a task after the press.
  const [write, setWrite] = useState<{
    settled: {
      diff: ReadonlySet<string>;
      // Set for an untracked file only: its partial stage re-keys the diff
      // from status, so the hold waits on status as well.
      status: ReadonlySet<string> | null;
    } | null;
  } | null>(null);
  // The fire-time refusal: set synchronously at the press and cleared when the
  // hold releases, so a second press inside the same frame never fires.
  const writingRef = useRef(false);
  const hunkFocusRef = useRef<HunkFocus | null>(null);
  // A pointer press anywhere after the hunk press drops its pending landing: a
  // click into the code also leaves focus on <body>, which would otherwise read
  // as the pressed button unmounting. Keys don't drop it: one that moves focus
  // fails the landing's focus check, and one that doesn't leaves the user where
  // the landing assumes.
  useEffect(() => {
    const drop = () => {
      hunkFocusRef.current = null;
    };
    document.addEventListener("pointerdown", drop, true);
    return () => document.removeEventListener("pointerdown", drop, true);
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
  const statusBehind =
    settled?.status != null && !answeredSince(status, settled.status);
  const refreshing =
    write !== null && (settled === null || diffBehind || statusBehind);
  // `parsed`, `hunkMode`, and `busy` are computed above the `!hunkMode` early
  // return because the hotkey registrations below run unconditionally and read
  // them.
  const busy =
    applyPatch.isPending ||
    applyPartial.isPending ||
    discardUntracked.isPending ||
    refreshing;
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
    if (statusBehind && statusIdle)
      void refetchStatus({ cancelRefetch: false });
  }, [
    diffBehind,
    diffIdle,
    statusBehind,
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
  // A selection is valid only against the diff text it was dragged against —
  // stale by text means every consumer sees no selection at the same instant.
  const selection =
    selectionState !== null && selectionState.forText === diff.data?.text
      ? selectionState.lines
      : null;
  // Preview swaps the staging view out entirely, so the selection actions and
  // the toggle can never be on screen together (the selection arm owns the
  // whole cluster while a drag selection exists). Same predicate as the
  // read-only surface, so the two hosts can't drift on what's previewable.
  const canPreview =
    hunkMode && canPreviewMarkdown(file.path, repoPath, workingRevs);
  const previewOn = canPreview && mdView === "preview";
  useFocusOnControlsSwap(previewOn, controlsRef);
  // A held or preparing slot is inert, but hotkeys and the portaled Discard
  // confirm reach past `inert`, so each gates on this as well.
  const { interactive } = useDiffPaneHold();
  // A confirm pending when the slot is held is dropped, not just hidden: a
  // retarget back to this file must never reopen it.
  if (!interactive && discard !== null) setDiscard(null);
  // One contextual chord: stage the selection on an unstaged file's diff,
  // unstage it on a staged one — mirroring the toolbar's primary button. Dead
  // while the Discard confirm is open (the global listener has no dialog guard)
  // and while the non-staging fallback renders.
  useHotkeyAction(
    "stage-selected-lines",
    () => applySelection({ cached: true, reverse: file.staged }),
    interactive && hunkMode && selection !== null && !busy && discard === null,
  );
  useHotkeyAction(
    "clear-line-selection",
    clearSelection,
    interactive && hunkMode && selection !== null && !busy && discard === null,
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
    interactive &&
      hunkMode &&
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
  const liveText = diff.data?.text;
  useEffect(() => {
    if (discard !== null && discard.forText !== liveText) setDiscard(null);
  }, [discard, liveText]);
  // The fallback view renders no confirm, so a close in progress ended with
  // its unmount: nothing is left to wait for.
  if (!hunkMode && confirmClosing) setConfirmClosing(false);
  // A flag flip can leave the decoded text byte-identical, so the text-keyed
  // guards above never fire for it; leaving hunk mode clears both here.
  if (!hunkMode && selectionState !== null) setSelectionState(null);
  if (!hunkMode && discard !== null) setDiscard(null);

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
        contentRevs={workingRevs}
        stagingSide={stagingSide}
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

  // Every write from this pane: refused while another is held, then held from
  // the press until the reads it invalidated answer again, with data or an
  // error (see `write`).
  async function runWrite(
    mutate: () => Promise<unknown>,
    focus: HunkFocus | null,
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
    hunkFocusRef.current = focus;
    const wasUntracked = untracked;
    setWrite({ settled: null });
    try {
      await mutate();
      clearSelection();
    } catch (e) {
      onError(e);
    } finally {
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
        settled: {
          diff: marks(repoKeys.diff(repoPath, file.path, file.staged), false),
          status: wasUntracked ? marks(repoKeys.status(repoPath), true) : null,
        },
      });
    }
  }

  function applyHunk(
    hunk: DiffHunk,
    opts: { cached: boolean; reverse: boolean },
    focus: HunkFocus,
  ) {
    if (!parsed) return;
    const patch = buildHunkPatch(parsed, hunk);
    void runWrite(() => applyPatch.mutateAsync({ patch, ...opts }), focus);
  }

  // Stage/unstage/discard the file-wide line selection. `build_partial_patch`
  // already distributes a multi-hunk selection, so hand it the WHOLE diff.
  function applySelection(opts: { cached: boolean; reverse: boolean }) {
    if (!selection || !diff.data) return;
    const diffText = diff.data.text;
    const selected = selection;
    void runWrite(
      () => applyPartial.mutateAsync({ diffText, selected, ...opts }),
      null,
    );
  }

  // Discard lines from an untracked (new) file: remove just those new-side line
  // numbers from the file. A new file is all additions, so there's nothing to
  // reverse-apply (reverse-applying its patch would delete the whole file).
  function discardLines(lines: number[], focus: HunkFocus | null) {
    if (lines.length === 0) return;
    const path = file.path;
    void runWrite(() => discardUntracked.mutateAsync({ path, lines }), focus);
  }

  // A whole-hunk action, fired by the per-hunk buttons with the diff text that
  // hunk was parsed from and the button pressed.
  function onHunkAction(
    hunk: DiffHunk,
    kind: HunkActionKind,
    forText: string,
    focus: HunkFocus,
  ) {
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
        label: hunk.header,
        newFile: untracked,
        forText,
        run: untracked
          ? () => discardLines(hunkAddedNewLines(hunk), focus)
          : () => applyHunk(hunk, { cached: false, reverse: true }, focus),
      });
    } else {
      applyHunk(hunk, { cached: true, reverse: kind === "unstage" }, focus);
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
                  onClick={() =>
                    applySelection({ cached: true, reverse: true })
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
                    onClick={() =>
                      applySelection({ cached: true, reverse: false })
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
                                null,
                              )
                          : () =>
                              applySelection({ cached: false, reverse: true }),
                      })
                    }
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
                onClick={clearSelection}
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
              hunkFocus={hunkFocusRef}
              focusHeld={confirmClosing}
              focusSink={focusSink}
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
  busy: boolean;
  onHunkAction: (
    hunk: DiffHunk,
    kind: HunkActionKind,
    focus: HunkFocus,
  ) => void;
}

/** Stage/Unstage + Discard for one hunk, wherever its host is. Both buttons are
 *  described by the hunk's line range: their names repeat on every hunk, and
 *  the hosts don't sit in hunk order in the tab sequence. */
function HunkActionButtons({
  hunk,
  index,
  staged,
  busy,
  onHunkAction,
}: HunkActionProps) {
  const rangeId = useId();
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
        disabled={busy}
        reason={UPDATING_DIFF_REASON}
        aria-describedby={rangeId}
        data-hunk-primary={index}
        onKeyDown={swallowRepeatedActivation}
        onClick={fire(staged ? "unstage" : "stage")}
      >
        {staged ? "Unstage" : "Stage"} hunk
      </DisabledReasonButton>
      <DisabledReasonButton
        variant="ghost"
        size="xs"
        className="text-destructive"
        disabled={busy}
        reason={UPDATING_DIFF_REASON}
        aria-describedby={rangeId}
        onKeyDown={swallowRepeatedActivation}
        onClick={fire("discard")}
      >
        Discard…
      </DisabledReasonButton>
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
 * across the whole file, and per-hunk Stage/Unstage/Discard buttons with
 * one host per hunk (`hunkHost`): overlaid on the `@@` row while the
 * gap above it is collapsed, inline in the library's extend row once the line
 * above shows, or the pane-top bar for a hunk starting on line 1. The library's
 * selection manager drives the drag, but the selection comes from our own row
 * anchors (its range is single-sided by model, and in split can retarget across
 * panes); only a unified Shift drag, which its range already models exactly,
 * rides it. We paint the `gd-line-selected` highlight ourselves — its own class
 * doesn't apply in this standalone setup.
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
  hunkFocus,
  focusHeld,
  focusSink,
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
  onHunkAction: (
    hunk: DiffHunk,
    kind: HunkActionKind,
    forText: string,
    focus: HunkFocus,
  ) => void;
  /** The button the pending write was fired from; consumed here once the
   *  refreshed hunks are on screen. */
  hunkFocus: RefObject<HunkFocus | null>;
  /** The Discard confirm is still closing; its focus return comes first. */
  focusHeld: boolean;
  /** Where focus lands when this view goes while a hunk action's move is
   *  pending: the action left no hunks, or the file left the pane. */
  focusSink: RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRepo = useUiStore((s) => s.repoPath);
  const { syntaxMap, customLanguages } = useEffectiveSyntax(activeRepo);
  const deferredText = useDeferredValue(diffText);
  const deferredPath = useDeferredValue(filePath);
  // The hunks parsed from `deferredText`: both resolve in the same deferred
  // render, so the overlay and its buttons pair with the rows on screen. Each
  // click carries `deferredText`, and the parent refuses it once the live text
  // has moved past the display.
  const viewHunks = useDeferredValue(hunks);
  const onDisplayedHunkAction = useCallback(
    (hunk: DiffHunk, kind: HunkActionKind, focus: HunkFocus) =>
      onHunkAction(hunk, kind, deferredText, focus),
    [onHunkAction, deferredText],
  );
  // The buttons hold until the display has caught up with the text the parent
  // released them for, not only until that text arrives.
  const held = busy || deferredText !== diffText;
  // The hunk a hunk action's focus last landed on, re-landable while armed
  // (see the re-land effect below). A pointer press or a fresh key press is the
  // user taking over; a held key's auto-repeats are not, since the press that
  // landed focus is still down. Past the bound, a remount is no longer this
  // action's.
  const relandRef = useRef<{ index: number; button: HTMLElement } | null>(null);
  const disarmRef = useRef<(() => void) | null>(null);
  const disarmReland = useCallback(() => disarmRef.current?.(), []);
  const armReland = useCallback((index: number, button: HTMLElement) => {
    disarmRef.current?.();
    relandRef.current = { index, button };
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
  }, []);
  useEffect(() => disarmReland, [disarmReland]);
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
  const split = viewMode === "split";
  // A split drag crosses whole rows, so each side of a crossed row is classified
  // against the diff's own `-`/`+` numbers: context and expanded context sit in
  // neither set. Keyed on `deferredText`, which classifies identically to the
  // `displayText` the rows are built from (shortenLongLines only truncates long
  // lines, preserving line count and numbering; capDiffText, which drops lines,
  // is not on this path). The parent's `hunks` prop tracks the LIVE text, which
  // can lead the deferred rows, so reusing it would misclassify in that window.
  const changed = useMemo(() => changedLinesOf(deferredText), [deferredText]);

  // Inline hunk headers ride the library's extend rows. Both props reach its
  // store in a passive effect, so everything a header shows (the hunks, held,
  // staged, the action) changes their identity; a ref-stable renderer would
  // freeze the headers on stale state. Always an object: the view applies an
  // undefined `extendData` as "no change", keeping stale entries.
  const extendData = useMemo(
    () => hunkHeaderExtendData(viewHunks, split),
    [viewHunks, split],
  );
  const renderExtendLine = useCallback(
    ({ data }: { data: HunkHeaderData }) => {
      const hunk = viewHunks[data.hunk];
      if (!hunk) return null;
      const r = hunkRange(hunk);
      if (data.side === "old")
        return <HunkHeaderBar label={`-${r.oldStart},${r.oldLines}`} />;
      return (
        <HunkHeaderBar
          label={split ? `+${r.newStart},${r.newLines}` : hunk.header}
        >
          <HunkActionButtons
            hunk={hunk}
            index={data.hunk}
            staged={staged}
            busy={held}
            onHunkAction={onDisplayedHunkAction}
          />
        </HunkHeaderBar>
      );
    },
    [viewHunks, split, staged, held, onDisplayedHunkAction],
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
        onSelectRef.current(next.length ? next : null, deferredText);
      },
    });
    paintLines(container, selectedRef.current ?? [], split); // re-assert after (re)mount
    return () => {
      container.removeEventListener("mousedown", onMouseDownCapture, true);
      container.removeEventListener("mouseover", onMouseOver);
      manager.destroy();
    };
  }, [diffFile, split, deferredText, changed]);

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
  // rebuild/expand/collapse/resize. A mutation's measure commits in the same
  // task as the rows it moved (see the MutationObserver below), so its rows
  // never paint apart from their buttons.
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
    measured.forFile === diffFile && measured.forHunks === viewHunks
      ? measured.list
      : [];
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !diffFile) return;
    let raf = 0;
    // The library builds its rows in a passive effect plus a later sync commit,
    // so this effect's own measure can run before they exist; the mutation that
    // inserts them measures again.
    const measure = () => {
      const rootTop = container.getBoundingClientRect().top;
      const list = viewHunks.map((h, i) => {
        const row =
          rowForLine(container, "new", hunkStart(h, "new")) ??
          rowForLine(container, "old", hunkStart(h, "old"));
        if (!row) return { top: -1, host: "none" as const };
        const prev = row.previousElementSibling;
        const host = hunkHost(prev?.getAttribute("data-state"), i);
        // An overlay sits on the `@@` row; the other hosts are in flow, so
        // only whether the row was found matters.
        const anchor = host === "row" && prev ? prev : row;
        return { top: anchor.getBoundingClientRect().top - rootTop, host };
      });
      const rowless =
        diffRendersRows(diffFile) &&
        list.length > 0 &&
        list.every((a) => a.top < 0);
      setMeasured((prev) => {
        const same = prev.forFile === diffFile && prev.forHunks === viewHunks;
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
          : { forFile: diffFile, forHunks: viewHunks, list };
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
  }, [diffFile, viewHunks]);

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
      const pending = hunkFocus.current;
      hunkFocus.current = null;
      if (pending === null) return;
      const land = () => landHunkFocus(pending, focusSink.current);
      if (!pending.viaConfirm) land();
      // A frame past the confirm's unmount, so the move lands after its return.
      else requestAnimationFrame(land);
    },
    [hunkFocus, focusSink],
  );
  // A layout switch drops a pending move: the buttons it would land on are not
  // the ones the press saw.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a layout switch is the trigger
  useEffect(
    () => () => {
      hunkFocus.current = null;
    },
    [split, hunkFocus],
  );
  // Once the hold releases and the refreshed hunks have hosts, focus moves to
  // the Stage/Unstage of the hunk now at the press's index, or of the last hunk
  // when fewer remain; `landHunkFocus` decides whether it moves at all.
  useLayoutEffect(() => {
    const pending = hunkFocus.current;
    const container = containerRef.current;
    if (pending === null || held || focusHeld || !container) return;
    if (anchors.length === 0) return;
    const index = Math.min(pending.index, viewHunks.length - 1);
    const target = primaryFor(container, index);
    if (target === undefined) {
      // That hunk has no host on screen yet (an inline header trails the
      // measure by a passive commit): a re-measure lands it, and two frames
      // without one drop the move rather than send focus elsewhere.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (hunkFocus.current === pending) hunkFocus.current = null;
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    hunkFocus.current = null;
    const land = () => {
      if (landHunkFocus(pending, target)) armReland(index, target);
    };
    if (!pending.viaConfirm) land();
    // A frame past the confirm's unmount, so the move lands after its return.
    else requestAnimationFrame(land);
  }, [held, focusHeld, anchors, viewHunks, hunkFocus, armReland]);
  // A landed focus can lose its button to a later rebuild: the whole-file
  // content read and the diff read can land in separate renders, and the
  // second remounts every host. While armed, focus that fell to <body> from the
  // detached button goes back to the same hunk's Stage/Unstage; focus anywhere
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
    const target = primaryFor(container, landed.index);
    if (target === undefined) return;
    target.focus({ preventScroll: true });
    landed.button = target;
  });
  // Settled once the rows exist: the library builds them in its own passive
  // effect, so a built diffFile can still paint rowless. A diff with no hunk
  // lines never gets a row, so it settles at build.
  useReportPaneSettled(
    !contentPending &&
      !holdForGrammar &&
      (diffFile === null ||
        !diffRendersRows(diffFile) ||
        anchors.some((a) => a.top >= 0)),
  );

  // Whole-file reads still settling, or a lazy built-in Shiki grammar still
  // loading: render nothing rather than build a diff we'd immediately restructure
  // or re-highlight (the single-paint gate). Must precede the empty-state
  // placeholder so loading never reads as "No changes to show". The effects above
  // guard on `!diffFile`, so they no-op while pending and re-bind on the single
  // build.
  if (contentPending || holdForGrammar) return null;
  if (!diffFile) return <DiffPlaceholder message="No changes to show" />;
  // A line-1 hunk has nothing above it to host its buttons — the pane-top bar
  // instead. Predicted from the hunk so it paints with the first rows; a measure
  // of this diffFile then wins.
  const firstNeedsHeader =
    !!viewHunks[0] &&
    (firstFound
      ? firstMeasured.host === "top"
      : !firstHunkHasSepRow(viewHunks[0]));
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
          <HunkActionButtons
            hunk={viewHunks[0]}
            index={0}
            staged={staged}
            busy={held}
            onHunkAction={onDisplayedHunkAction}
          />
        </HunkHeaderBar>
      )}
      <DiffView<HunkHeaderData>
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
        extendData={extendData}
        renderExtendLine={renderExtendLine}
      />
      {anchors.map((a, i) =>
        viewHunks[i] && a.host === "row" && a.top >= 0 ? (
          // Buttons sit ON the `@@` separator row (never on code), right-aligned
          // to clear the native expand controls. A press here can't start a
          // drag: see HunkHeaderBar.
          <div
            key={`${i}:${viewHunks[i].header}`}
            className="absolute right-3 z-10 flex -translate-y-px gap-1"
            style={{ top: a.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HunkActionButtons
              hunk={viewHunks[i]}
              index={i}
              staged={staged}
              busy={held}
              onHunkAction={onDisplayedHunkAction}
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
