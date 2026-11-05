import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  CaretRightIcon,
  FunnelIcon,
  StackIcon,
  TreeViewIcon,
} from "@phosphor-icons/react";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { InfoNote } from "@/components/info-note";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import { restingDiffMessage } from "@/features/diff/diff-resting-message";
import { BlameDialog } from "@/features/history/BlameDialog";
import { FileHistoryDialog } from "@/features/history/FileHistoryDialog";
import { type ConflictSides, conflictSides } from "@/lib/git/conflict";
import { markNeedsConfirm } from "@/lib/git/conflict-parse";
import { SIDES_READ_CHUNK } from "@/lib/git/conflict-prefilter";
import {
  aiExcludePatternLinesForPath,
  globLiteralPath,
  literalPathspec,
} from "@/lib/git/glob";
import {
  useAppendRepoAiIgnore,
  useAppendToGitignore,
  useBranchAheadCount,
  useDefaultBranch,
  useDiscardAll,
  useDiscardPaths,
  useForgeStatus,
  useRepoStatus,
  useStage,
  useStashAll,
  useStashCount,
  useStashPaths,
  useUnstage,
  useUntrack,
  useWorkingLineStats,
} from "@/lib/git/queries";
import { reservedDeviceName } from "@/lib/git/reserved-device-name";
import type { ChangeKind, FileEntry, RepoStatus } from "@/lib/git/types";
import { formatBinding, hasChordModifier } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { flattenPathTree, pathBasename } from "@/lib/path-tree";
import { CHANGES_VIEW_MODES } from "@/lib/settings/api";
import {
  useAiEnabled,
  useReviewConfigured,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { landedIn, refuseIfSwitched } from "@/lib/stores/notifications";
import { useStashReapplyMarker } from "@/lib/stores/stash-reapply-marker";
import { type SelectedFile, useUiStore } from "@/lib/stores/ui";
import { ignoreToast, toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { mergePinnedIndexes } from "./BranchSwitcherRows";
import {
  bulkRowTargets,
  excludeConflicted,
  isConflictedEntry,
  rowEntry,
} from "./bulk-row-targets";
import {
  ChangesContextMenuItems,
  type FolderMenuCounts,
  type MenuTarget,
} from "./ChangesContextMenu";
import { ChangesEmptyState } from "./ChangesEmptyState";
import { ConflictBanner } from "./ConflictBanner";
import {
  type ChangeActionScope,
  discardConfirmCopy,
  stashConfirmCopy,
  staysOutOfStash,
} from "./changes-confirm-copy";
import { type MarkerFlag, markerStagePrompt } from "./conflict-confirms";
import { FileRow, MARKER_CHECK_PENDING } from "./FileRow";
import {
  entriesUnderFolder,
  parseFolderRowKey,
  rowAfterFolderLeaves,
} from "./folder-stage-targets";
import {
  cursorAfterAdvance,
  dialogClaimStep,
  nextFileKey,
  pruneDecision,
  selectionAfterAdvance,
  type WaitingFocus,
} from "./next-file-after-stage";
import { StashesDialog } from "./StashesDialog";
import {
  openStatusErrorDetails,
  StatusReadErrorState,
  StatusRefreshFailedStrip,
  statusReadFailed,
  useRetainedStatusError,
} from "./StatusReadError";
import {
  advanceLanding,
  type ChangesSection,
  pruneCollapsedSectionKeys,
  rowKeySection,
} from "./section-collapse";
import { selectionFollowingShownFile } from "./shown-file-follow";
import { STATUS_READ_FAILED_REASON } from "./sync-controls-state";

/** The pathspecs that unstage one entry — a staged rename is "delete old path +
 *  add new path", so both halves are needed or the old path's deletion stays
 *  staged. Literal: these are paths the user picked, and a `[slug]`-style one
 *  would otherwise unstage its glob-siblings too. */
function unstagePaths(entry: FileEntry): string[] {
  return (entry.origPath ? [entry.path, entry.origPath] : [entry.path]).map(
    literalPathspec,
  );
}

/** Windows resolves a reserved device name to the DEVICE, so `git add` reads it
 *  and aborts the whole pathspec batch — every stage path filters these out. */
function canStage(entry: FileEntry): boolean {
  return reservedDeviceName(entry.path) === null;
}

/** Whether a stage of `conflicted` may go ahead: true when no file still holds
 *  markers, else the user's answer to ONE prompt. Reads fresh from disk, since a
 *  cached read can predate the markers; a failed read asks rather than staging
 *  silently or refusing. Refuses (resolving false, with a notice) without
 *  asking if the active repo changed during the reads. Never rejects. */
async function confirmMarkerStage(
  repoPath: string,
  conflicted: FileEntry[],
  bulk: boolean,
): Promise<boolean> {
  // Index-aligned with `conflicted`: chunks run in order and append in order.
  const reads: PromiseSettledResult<ConflictSides>[] = [];
  for (let i = 0; i < conflicted.length; i += SIDES_READ_CHUNK) {
    const chunk = conflicted.slice(i, i + SIDES_READ_CHUNK);
    reads.push(
      ...(await Promise.allSettled(
        chunk.map((e) => conflictSides(repoPath, e.path, [])),
      )),
    );
  }
  const flags = conflicted.flatMap((e, i): MarkerFlag[] => {
    const read = reads[i];
    const name = pathBasename(e.path);
    if (read.status === "rejected") return [{ name, unchecked: true }];
    return markNeedsConfirm(read.value) ? [{ name, unchecked: false }] : [];
  });
  if (flags.length === 0) return true;
  if (
    refuseIfSwitched(
      repoPath,
      "nothing was staged",
      "before the marker check finished",
    )
  )
    return false;
  return useConfirm.getState().ask(markerStagePrompt(flags, bulk));
}

type FilterKind = "included" | "excluded" | "new" | "modified" | "deleted";

function hasKind(entry: FileEntry, kinds: ChangeKind[]): boolean {
  return [entry.staged, entry.unstaged].some(
    (k) => k !== null && kinds.includes(k),
  );
}

const FILTER_PREDICATES: Record<FilterKind, (e: FileEntry) => boolean> = {
  included: (e) => e.staged !== null,
  excluded: (e) => e.unstaged !== null,
  new: (e) => hasKind(e, ["added", "untracked"]),
  modified: (e) => hasKind(e, ["modified"]),
  deleted: (e) => hasKind(e, ["deleted"]),
};

const FILTER_LABELS: Record<FilterKind, string> = {
  included: "Included in commit",
  excluded: "Excluded from commit",
  new: "New files",
  modified: "Modified files",
  deleted: "Deleted files",
};

/** A flattened row in the virtualized changes list: a section header, a file, or
 *  (tree mode) a compacted directory. One flat list (not two nested sections)
 *  keeps virtualization, cross-section arrow-key navigation, and range selection
 *  in a single index space. */
type FlatRow =
  | { type: "header"; section: "staged" | "unstaged"; count: number }
  | {
      type: "folder";
      section: "staged" | "unstaged";
      path: string;
      label: string;
      depth: number;
      count: number;
      collapsed: boolean;
    }
  /** `depth` is the tree-mode indent level; list mode leaves it unset. */
  | { type: "file"; entry: FileEntry; staged: boolean; depth?: number };

type FolderRow = Extract<FlatRow, { type: "folder" }>;

/** Focus nobody owns: the document body, nothing at all, or a node a render has
 *  detached. Every focus restore here gates on it — a live control's caret (the
 *  filter input, the toggle button) is never ours to take. */
function focusIsOrphaned(): boolean {
  const focused = document.activeElement;
  return !focused || focused === document.body || !focused.isConnected;
}

/** Whether a restore may move focus away on behalf of the row `key` names: focus
 *  sits on that row (still mounted, about to go) or on nobody. A view flip
 *  dispatched from the palette leaves the doomed row focused, so orphan-only
 *  would never fire — and a caret in a live control must still be left alone. */
function focusLeavingRow(key: string): boolean {
  const focused = document.activeElement;
  return (
    (focused instanceof HTMLElement &&
      focused.getAttribute("data-row") === key) ||
    focusIsOrphaned()
  );
}

/** Drops the selection keys hidden under `collapsedKeys` (each `"<section>:<dir>"`,
 *  sharing the selection keys' `"<section>:<path>"` spelling). One rule for both
 *  ways a row can go hidden — collapsing a folder, and entering tree mode with
 *  folders already collapsed — so a collapsed folder can never hold a
 *  selectable-but-invisible row. Returns `keys` itself when nothing was hidden. */
function pruneHiddenKeys(
  keys: Set<string>,
  collapsedKeys: Iterable<string>,
): Set<string> {
  const prefixes = [...collapsedKeys].map((k) => `${k}/`);
  if (prefixes.length === 0) return keys;
  const next = new Set(
    [...keys].filter((k) => !prefixes.some((p) => k.startsWith(p))),
  );
  return next.size === keys.size ? keys : next;
}

/** A row's identity, shared by React's key and the virtualizer's `getItemKey`
 *  so the two can't drift. A measured height only follows its row while
 *  `getItemKey`'s identity is re-minted per sequence: the key alone never
 *  invalidates the virtualizer's index-ordered measurement projection. */
function keyOf(path: string, staged: boolean): string {
  return `${staged ? "staged" : "unstaged"}:${path}`;
}
function rowKeyOf(row: FlatRow): string {
  if (row.type === "header") return `header:${row.section}`;
  if (row.type === "folder") return `folder:${row.section}:${row.path}`;
  return keyOf(row.entry.path, row.staged);
}

/** Popups whose close hands focus back: any dialog or menu in the app, the
 *  row's own context menu among them, so an action fired from one keeps the
 *  list's claim. Another popup's hold ends once its close lands live focus. */
const CLAIM_HOLD_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"]';

/** Where focus sits for an advance that wants to land it (see
 *  {@link dialogClaimStep}). */
function waitingFocus(): WaitingFocus {
  if (focusIsOrphaned()) return "orphaned";
  return document.activeElement?.closest(CLAIM_HOLD_SELECTOR)
    ? "dialog"
    : "other";
}

/** How long an advance waits for a closing dialog to hand focus back: a time
 *  bound (frame rates vary), well past the confirm's 100 ms exit animation. */
const DIALOG_CLAIM_MS = 500;

/** How often a focus claim re-checks while a popup stays open: nothing can land
 *  before it closes, so a frame-rate poll would only burn work. */
const DIALOG_HOLD_POLL_MS = 100;

/** Whether focus sits in a popup that is still open; Base UI marks a closing
 *  popup `data-closed` for its exit animation, and the claim bound starts then. */
function focusInOpenPopup(): boolean {
  const popup = document.activeElement?.closest(CLAIM_HOLD_SELECTOR);
  return popup ? !popup.hasAttribute("data-closed") : false;
}

/** Whether `path` has a record on the given side of `entries` — side-aware,
 *  since Git can list one path as two records (a staged `D.` beside a `?`). */
function hasSide(entries: FileEntry[], path: string, staged: boolean): boolean {
  return entries.some(
    (e) =>
      e.path === path && (staged ? e.staged !== null : e.unstaged !== null),
  );
}

/** Splits a file row key (`"<section>:<path>"`) back into its parts. */
function splitFileKey(key: string): { staged: boolean; path: string } {
  return {
    staged: key.startsWith("staged:"),
    path: key.slice(key.indexOf(":") + 1),
  };
}

function isFileKey(key: string): boolean {
  return key.startsWith("staged:") || key.startsWith("unstaged:");
}

/** Zero-width space, built from its code point so no invisible byte sits in
 *  source. Toggled into the live region so a repeated message re-announces. */
const ZWSP = String.fromCharCode(0x200b);

/** What left its section in an advance announcement: a file row, a focused
 *  folder row whose files all left (`folder-hidden:` while the filter still
 *  hides some of its files), or a focused header control whose whole section
 *  emptied. */
type AdvanceLead =
  | "unstaged"
  | "staged"
  | "folder:unstaged"
  | "folder:staged"
  | "folder-hidden:unstaged"
  | "folder-hidden:staged"
  | "header:unstaged"
  | "header:staged";

const ADVANCE_LEADS: Record<AdvanceLead, (path: string) => string> = {
  unstaged: (path) => `${path} has no unstaged changes left.`,
  staged: (path) => `${path} has no staged changes left.`,
  "folder:unstaged": (path) => `${path} has no unstaged changes left.`,
  "folder:staged": (path) => `${path} has no staged changes left.`,
  "folder-hidden:unstaged": (path) =>
    `${path} has no visible unstaged changes left.`,
  "folder-hidden:staged": (path) =>
    `${path} has no visible staged changes left.`,
  "header:unstaged": () => "Nothing left in Changes.",
  "header:staged": () => "Nothing left in Staged.",
};

/** The advance's outcome: the selection moved (focus did not), focus moved
 *  (the focused row announces its own name), the selection stayed on a file
 *  that didn't move (its diff is still on screen), or nothing is selected. */
type AdvanceTail = "shown" | "focused" | "kept" | "none";

const ADVANCE_TAILS: Record<
  AdvanceTail,
  (nextPath: string, entryCount: number) => string
> = {
  shown: (nextPath) => ` Showing ${nextPath}.`,
  focused: () => "",
  kept: () => "",
  // The pane's own resting copy, so it stays true whatever stopped the advance.
  none: (_, entryCount) => ` ${restingDiffMessage(false, entryCount, false)}.`,
};

/** The indent level a row sits at; headers and list-mode files are at the root. */
function rowDepth(row: FlatRow): number {
  if (row.type === "header") return 0;
  if (row.type === "folder") return row.depth;
  return row.depth ?? 0;
}

/** A section's collapsed directories, its `"<section>:"` prefix stripped. */
function sectionCollapsed(
  collapsedFolders: Set<string>,
  section: "staged" | "unstaged",
): Set<string> {
  const prefix = `${section}:`;
  return new Set(
    [...collapsedFolders]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length)),
  );
}

/** The filtered sections and the rows they flatten to. Pure in its inputs so
 *  the panel memoizes it: selection and cursor churn never rebuild the rows
 *  (the React Compiler bails on ChangesPanel, so nothing else memoizes it). */
function buildChangeRows(
  entries: FileEntry[],
  text: string,
  activeKinds: Set<FilterKind>,
  treeMode: boolean,
  collapsedFolders: Set<string>,
  collapsedSections: Set<ChangesSection>,
) {
  function visible(entry: FileEntry): boolean {
    if (text && !entry.path.toLowerCase().includes(text)) return false;
    if (activeKinds.size === 0) return true;
    for (const k of activeKinds) if (FILTER_PREDICATES[k](entry)) return true;
    return false;
  }
  const unstagedEntries = entries.filter(
    (e) => e.unstaged !== null && visible(e),
  );
  const stagedEntries = entries.filter((e) => e.staged !== null && visible(e));

  // One flattened list (section headers + their files) drives a single
  // virtualizer, so a working tree with thousands of changed files only renders
  // a window of rows instead of mounting every row (which used to crash). Tree
  // mode swaps each section's flat run for a compacted directory tree; the
  // filter has already been applied, so folder counts describe what's listed.
  const flatRows: FlatRow[] = [];
  function pushSection(
    section: "staged" | "unstaged",
    sectionEntries: FileEntry[],
  ) {
    if (sectionEntries.length === 0) return;
    const staged = section === "staged";
    flatRows.push({ type: "header", section, count: sectionEntries.length });
    // Before the view-mode branch, so a collapsed section hides in both modes.
    if (collapsedSections.has(section)) return;
    if (!treeMode) {
      for (const entry of sectionEntries)
        flatRows.push({ type: "file", entry, staged });
      return;
    }
    const collapsed = sectionCollapsed(collapsedFolders, section);
    // A rename is placed by its NEW path; the old one is only the label's left
    // half, and the row's identity is the new path everywhere else too.
    for (const row of flattenPathTree(
      sectionEntries,
      (e) => e.path,
      collapsed,
    )) {
      if (row.kind === "folder") {
        flatRows.push({
          type: "folder",
          section,
          path: row.path,
          label: row.label,
          depth: row.depth,
          count: row.fileCount,
          collapsed: collapsed.has(row.path),
        });
      } else {
        flatRows.push({
          type: "file",
          entry: row.item,
          staged,
          depth: row.depth,
        });
      }
    }
  }
  pushSection("staged", stagedEntries);
  pushSection("unstaged", unstagedEntries);

  // The navigable rows in render order (headers excepted), so ArrowUp/Down walk
  // the cursor across both sections — and, in tree mode, across folder rows.
  const navRows = flatRows.filter((r) => r.type !== "header");
  // The advance's inputs: the file rows on screen in nav order (filter-hidden
  // rows and collapsed folders' children are already out), and the subset a
  // successor may be — a conflicted file never is.
  const navFileKeys: string[] = [];
  const advanceEligible = new Set<string>();
  for (const r of navRows) {
    if (r.type !== "file") continue;
    const key = rowKeyOf(r);
    navFileKeys.push(key);
    if (!isConflictedEntry(r.entry)) advanceEligible.add(key);
  }
  return {
    unstagedEntries,
    stagedEntries,
    flatRows,
    navRows,
    navFileKeys,
    advanceEligible,
  };
}

export function ChangesPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  /** The Changes tab is the visible one. The line-count poll gates on this, not
   *  on mounting, as a backstop: a `<TabPanel>`-hidden panel holds no observers. */
  active: boolean;
}) {
  const status = useRepoStatus(repoPath);
  const stage = useStage(repoPath);
  const unstage = useUnstage(repoPath);
  const discardPaths = useDiscardPaths(repoPath);
  const discardAll = useDiscardAll(repoPath);
  const stashPaths = useStashPaths(repoPath);
  const stashAll = useStashAll(repoPath);
  const appendIgnore = useAppendToGitignore(repoPath);
  const appendAiIgnore = useAppendRepoAiIgnore(repoPath);
  const untrack = useUntrack(repoPath);
  const selectedFile = useUiStore((s) => s.selectedFile);
  const selectFile = useUiStore((s) => s.selectFile);
  const clearSelectedFile = useUiStore((s) => s.clearSelectedFile);
  const advanceSelectedFile = useUiStore((s) => s.advanceSelectedFile);
  const startResolveOne = useConflictResolve((s) => s.startOne);
  const startResolveAll = useConflictResolve((s) => s.startAll);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const stashCount = useStashCount(repoPath);
  const portalContainer = usePanelPortalContainer();
  // A confirm dialog is open when its scope is non-null. "files" covers a
  // single right-clicked row and a multi-selection alike (1+ entries); "all"
  // is the whole working tree (from the section-header menu).
  const [discardScope, setDiscardScope] = useState<ChangeActionScope>(null);
  const [stashScope, setStashScope] = useState<ChangeActionScope>(null);
  // Each confirm's title/body/label is derived from its scope further down.
  const shownDiscardScope = useRetained(discardScope);
  const shownStashScope = useRetained(stashScope);
  // Multi-selection for bulk stash/discard, keyed like the rendered rows
  // ("staged:path" / "unstaged:path"). `selectedFile` stays the active row
  // whose diff is shown; `anchorKey` is the pivot for shift-range selection.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  // Bumped by every writer that installs a NEW selection (a click, a range, an
  // arrow move, a stage's advance, the shown-file follow), never by a prune: a
  // prune only shrinks the selection the user made, so it is still theirs.
  const selectionGen = useRef(0);
  /** A clear after an await: only while no newer selection replaced the one
   *  the action started from, and only in the repo it started in (the panel
   *  outlives a repo switch, and keys are side + path alone). */
  function clearSelectionIfUnchanged(gen: number, repo: string) {
    if (selectionGen.current !== gen || !landedIn(repo).live) return;
    setSelectedKeys(new Set());
  }
  // The shown file as the panel itself last wrote it (the store keeps the very
  // object): any other value came from a route outside the panel, and the
  // multi-selection follows it there.
  const ownShownWrite = useRef<SelectedFile | null>(null);
  // The shown file the follow effect last saw, so it acts only on a change.
  const shownSeen = useRef(selectedFile);
  // Tree mode's collapsed directories, keyed `"<section>:<dirPath>"`. Session-local
  // by design: the changes list is ephemeral, so a collapse outlives neither a
  // repo switch nor a restart.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  // The collapsed Staged / Changes sections. Session-local like folder
  // collapse (no settings key): reset on a repo switch, gone on restart.
  const [collapsedSections, setCollapsedSections] = useState<
    Set<ChangesSection>
  >(new Set());
  // The nav cursor when it rests on a folder row (which has no diff to show, so
  // `selectedFile` stays where it was). Null = the cursor follows `selectedFile`.
  const [activeFolderKey, setActiveFolderKey] = useState<string | null>(null);
  // Re-minted when focus landing on a file row moves the cursor off that row,
  // onto the shown file: that commit's cursor change must not scroll the list,
  // which would carry the row out from under a press still in progress.
  const [focusCursorMove, setFocusCursorMove] = useState<object>(() => ({}));
  const [filterText, setFilterText] = useState("");
  const [activeKinds, setActiveKinds] = useState<Set<FilterKind>>(new Set());
  const [stashesOpen, setStashesOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  // The one shared context menu acts on whatever was right-clicked.
  const [menuTarget, setMenuTarget] = useState<MenuTarget>(null);
  // A conflicted stage's marker check and prompt are in flight. The state drives
  // the `mutating` disables; the ref is the fire-time refusal in stageGuarded.
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const viewToggleRef = useRef<HTMLButtonElement>(null);
  // A silent focus landing above the list: a clean tree's, where no toolbar
  // renders, the file list's when a failed status read recovers, and an
  // advance's when the filter or a folded folder hides its target row.
  const markerLandingRef = useRef<HTMLSpanElement>(null);
  // Where focus goes when the banner's reapply rows unmount under it: the
  // tree-view toggle while the toolbar is mounted, else the landing span.
  const landingRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return viewToggleRef.current ?? markerLandingRef.current;
      },
    }),
    [],
  );
  // A cursor row a horizontal jump could not focus because the virtualizer had
  // not mounted it yet; claimed once the scroll brings it in.
  const pendingFocusKey = useRef<string | null>(null);
  // The view mode a flip-armed claim waits for; null = claimable right away.
  const pendingFocusMode = useRef<"list" | "tree" | null>(null);
  // The row focus sat in when that claim was armed; null = focus was not on a
  // row (a background arm, with the caret in the filter or outside the list).
  const pendingFocusSource = useRef<string | null>(null);
  // A fresh object per arm, so a loop waiting on one claim can tell it from a
  // later arm of the same key.
  const pendingFocusToken = useRef<object | null>(null);
  // The claim was armed by a view flip: the only kind that waits out a dialog.
  const pendingFocusFromFlip = useRef(false);
  // Set for a claim whose row is NOT the cursor (an advance landing focus on a
  // row it does not select): the cursor when it was armed, so only a NEWER
  // cursor move makes it stale. Null = an ordinary cursor claim.
  const pendingFocusCursorAtArm = useRef<{ cursor: string | null } | null>(
    null,
  );
  // That non-cursor claim's row, as state: the virtualized child must scroll to
  // it, and only a render reaches the child.
  const [focusTargetKey, setFocusTargetKey] = useState<string | null>(null);
  // Where focus inside the list last sat — a row key, or `"header:<section>"`
  // for a section header's control. Kept through an unmount or a window blur,
  // and while a dialog (the marker confirm) holds focus; cleared when focus
  // moves anywhere else, so an advance never takes focus it did not own.
  const listFocusRef = useRef<string | null>(null);
  // The row DOM focus is in, as state: it outranks the cursor as the roving tab
  // stop (an advance can focus a row it doesn't select). Null once focus leaves
  // the list, so Tab re-enters at the cursor.
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  // Single-file toggles that settled but whose row the status read has not
  // moved yet: a second press in that window would act on the stale row.
  // Cleared whenever a status fetch completes, changed or not (a no-op stage
  // moves no row), and on a repo switch.
  const pendingLeaveKeys = useRef<Set<string>>(new Set());
  // Bumped per status transition and repo switch: a deferred focus claim or
  // announcement from an older one finds it moved and does nothing.
  const transitionGen = useRef(0);
  // The conflict-resolve walk was active for this repo at, or since, the last
  // status read: the walk closes before its last file's stage lands.
  const walkSeen = useRef(false);
  // The last advance's announcement, with the status read it describes: shown
  // only while that read is current (a failed read recovering never hands the
  // region a stale line), and cleared on a repo switch, since switching back
  // restores the cached read's identity.
  const [advanceNote, setAdvanceNote] = useState<{
    text: string;
    seq: number;
    read: RepoStatus | undefined;
  }>({ text: "", seq: 0, read: undefined });

  const readFailed = statusReadFailed(status);
  // query-core keeps `error` through a refetch while data is held, so this
  // holds steady across polls and clears on the first good read.
  const statusRefreshFailed = status.data !== undefined && status.isError;
  const retainedStatusError = useRetainedStatusError({
    repoPath,
    error: status.error ?? status.failureReason,
  });

  const entries = status.data?.entries ?? [];
  // The error block unmounts when the first good read lands. Only when focus
  // was inside it then and fell to <body> does the landing above the list or
  // the clean state take it.
  const { hostRef: rescueHostRef, retryRef: errorBlockRef } =
    useRetryFocusRescue(readFailed);
  const markerLandingEl = useCallback(
    (node: HTMLSpanElement | null) => {
      markerLandingRef.current = node;
      rescueHostRef(node);
    },
    [rescueHostRef],
  );
  const conflictedPaths = entries.filter(isConflictedEntry).map((e) => e.path);
  const canResolveConflicts =
    aiEnabled && reviewConfigured && conflictedPaths.length > 0;

  const lineStats = useWorkingLineStats(repoPath, active && entries.length > 0);
  const stagedStats = new Map(
    (lineStats.data?.staged ?? []).map((e) => [e.path, e]),
  );
  const unstagedStats = new Map(
    (lineStats.data?.unstaged ?? []).map((e) => [e.path, e]),
  );
  // Each row reads its OWN side, never a shared or summed number: a file staged
  // and then re-edited shows index-vs-HEAD counts on its Staged row and
  // worktree-vs-index counts on its Changes row. The kind gate lives here alone —
  // numstat emits duplicate noise rows for conflicted paths, so those render a
  // blank slot. Untracked files are counted backend-side onto the unstaged side.
  function statFor(entry: FileEntry, staged: boolean) {
    const kind = staged ? entry.staged : entry.unstaged;
    if (kind === "conflicted") return undefined;
    return (staged ? stagedStats : unstagedStats).get(entry.path);
  }

  // Empty-state suggestions: a published repo offers "View on GitHub"; a
  // branch with commits the default branch doesn't have offers a PR. The
  // comparison only runs while the tree is clean, so the daily loop never
  // pays for it.
  const gh = useForgeStatus(repoPath);
  // The empty-state "View on GitHub" suggestion is GitHub-only (a web link).
  // The "Open pull request" suggestion is gated on proposeCount alone — it routes
  // to the Compare tab, whose create affordance is provider-aware (GitHub + GitLab).
  const ghReady =
    Boolean(gh.data?.installed && gh.data?.authenticated && gh.data?.repo) &&
    gh.data?.provider === "github";
  const defaultBranch = useDefaultBranch(repoPath);
  const branch = status.data?.branch;
  const currentName = branch?.name ?? null;
  const defaultName = defaultBranch.data ?? null;
  const treeClean = !status.isPending && entries.length === 0;
  // An unborn HEAD (no commits yet, oid null) is a brand-new repo — the empty
  // Changes view becomes "make your first commit" guidance instead of the
  // caught-up actions, which assume there's history to act on.
  const isUnborn = Boolean(branch && !branch.detached && branch.oid === null);
  const canCompareDefault =
    treeClean &&
    !branch?.detached &&
    currentName !== null &&
    defaultName !== null &&
    currentName !== defaultName;
  const aheadOfDefault = useBranchAheadCount(
    repoPath,
    canCompareDefault ? defaultName : null,
    canCompareDefault ? currentName : null,
  );
  const proposeCount = canCompareDefault ? (aheadOfDefault.data ?? 0) : 0;

  const text = filterText.trim().toLowerCase();
  // Keyed on the build's raw inputs only; `settings.data?.changesViewMode` is
  // the `viewMode` declared below.
  const {
    unstagedEntries,
    stagedEntries,
    flatRows,
    navRows,
    navFileKeys,
    advanceEligible,
  } = useMemo(
    () =>
      buildChangeRows(
        status.data?.entries ?? [],
        text,
        activeKinds,
        settings.data?.changesViewMode === "tree",
        collapsedFolders,
        collapsedSections,
      ),
    [
      status.data?.entries,
      text,
      activeKinds,
      settings.data?.changesViewMode,
      collapsedFolders,
      collapsedSections,
    ],
  );
  // What "Stage all" can actually reach: the excluded rows stay listed, each
  // wearing its own explanation, so skipping them needs no toast.
  const stageableUnstaged = unstagedEntries.filter(canStage);
  const nothingMatches =
    entries.length > 0 &&
    stagedEntries.length === 0 &&
    unstagedEntries.length === 0;

  const viewMode = settings.data?.changesViewMode ?? "list";
  const treeMode = viewMode === "tree";
  const activeKey = selectedFile
    ? keyOf(selectedFile.path, selectedFile.staged)
    : null;
  // Row actions act on the selected rows' own records, so a staged row never
  // drags in its path's unstaged side or untracked twin; path-level actions
  // (stash, ignore, untrack, exclude) take each selected path once.
  const bulk = bulkRowTargets(selectedKeys, entries);
  const stageableSelected = bulk.unstagedRows.filter(canStage);
  const selectedDiscard = excludeConflicted(bulk.unstagedRows);
  const stashablePathCount = bulk.pathEntries.filter(
    (e) => !staysOutOfStash(e),
  ).length;
  // Any unmerged entry makes git refuse every path stash, so Stash waits.
  const anyConflicted = conflictedPaths.length > 0;

  /** A section's collapsed directories, its `"<section>:"` prefix stripped. */
  function collapsedIn(section: "staged" | "unstaged"): Set<string> {
    return sectionCollapsed(collapsedFolders, section);
  }

  // The cursor may rest on a folder, which owns no diff; file rows keep pointing
  // at `selectedFile`, so selection behaviour is unchanged.
  const cursorKey = activeFolderKey ?? activeKey;
  const navIndex = cursorKey
    ? navRows.findIndex((r) => rowKeyOf(r) === cursorKey)
    : -1;
  // The list's one roving tab stop, so Tab enters at the row the user is on and
  // leaves in one step: the focused row, else the cursor, else the first row.
  // Header and toolbar controls keep their own stops.
  const tabStopKey: string | null =
    focusedRowKey !== null && navRows.some((r) => rowKeyOf(r) === focusedRowKey)
      ? focusedRowKey
      : navIndex !== -1
        ? cursorKey
        : navRows.length > 0
          ? rowKeyOf(navRows[0])
          : null;

  /** Moves the cursor to `row` (at `to` in `navRows`); `shift` extends the
   *  selection from the anchor. Folder rows take the cursor alone. */
  function activateRow(row: FlatRow, to: number, shift: boolean) {
    if (row.type === "folder") {
      setActiveFolderKey(rowKeyOf(row));
      return;
    }
    if (row.type === "header") return;
    setActiveFolderKey(null);
    const key = rowKeyOf(row);
    select(row.entry, row.staged);
    if (shift && anchorKey) {
      const a = navRows.findIndex((r) => rowKeyOf(r) === anchorKey);
      // An anchor that has gone hidden (collapsed away, committed away) leaves
      // no range to extend; fall through and re-anchor on the landed row.
      if (a !== -1) {
        const [lo, hi] = a <= to ? [a, to] : [to, a];
        // Folder rows contribute no keys: a range spans the files it covers.
        selectionGen.current += 1;
        setSelectedKeys(
          new Set(
            navRows
              .slice(lo, hi + 1)
              .filter((r) => r.type === "file")
              .map(rowKeyOf),
          ),
        );
        return;
      }
    }
    selectionGen.current += 1;
    setSelectedKeys(new Set([key]));
    setAnchorKey(key);
  }

  /** Focus + reveal a row the arrow keys moved the cursor to. A jump past the
   *  virtualizer's overscan window finds no node, so it defers instead:
   *  unfocused, the row the user came from unmounts and every arrow key goes
   *  dead. */
  function focusRow(key: string) {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(key)}"]`,
    );
    if (!el) {
      deferFocusRow(key);
      return;
    }
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }

  /** Arms the claim without trying the DOM — the one place that writes the
   *  pending key. For a row mounted NOW that the coming re-render may carry out
   *  of the virtualized window: `focusRow` would find it, re-focus the node that
   *  already has focus, and arm nothing for the window exit. `untilMode` holds
   *  the claim until that view mode is on screen (see {@link claimPendingFocus}).
   *  `cursorAtArm` arms a NON-cursor claim: a row focus belongs on that the
   *  cursor does not name, which the child scrolls to on its own. Returns the
   *  arm's token (see `pendingFocusToken`). */
  function deferFocusRow(
    key: string,
    untilMode?: "list" | "tree",
    opts?: { cursorAtArm: string | null },
  ): object {
    const token = {};
    pendingFocusKey.current = key;
    pendingFocusToken.current = token;
    pendingFocusFromFlip.current = untilMode !== undefined;
    pendingFocusMode.current = untilMode ?? null;
    pendingFocusCursorAtArm.current = opts
      ? { cursor: opts.cursorAtArm }
      : null;
    setFocusTargetKey(opts ? key : null);
    // Where the gesture started, so the claim can tell focus that never moved
    // from focus that belongs to somebody else. Null for the arms that fire
    // while the caret is outside the list — they stay orphan-only.
    const from = focusedNavRow();
    pendingFocusSource.current = from ? rowKeyOf(from.row) : null;
    return token;
  }

  /** A claim and its source row retire together — nothing reads one without the
   *  other. */
  function clearPendingFocus() {
    pendingFocusKey.current = null;
    pendingFocusToken.current = null;
    pendingFocusFromFlip.current = false;
    pendingFocusSource.current = null;
    pendingFocusCursorAtArm.current = null;
    // A settled claim must not re-scroll the list on an <Activity> re-show.
    setFocusTargetKey(null);
  }

  /** Retires a non-cursor claim whose row never mounted in time — only that
   *  claim: a newer one armed meanwhile stays. */
  function dropFocusTarget(key: string) {
    if (pendingFocusKey.current === key && pendingFocusCursorAtArm.current)
      clearPendingFocus();
  }

  /** Claims focus for a deferred row once the list has scrolled to it. Returns
   *  false only while the claim cannot be settled yet, so the caller can retry on
   *  a later frame. */
  function claimPendingFocus(): boolean {
    const key = pendingFocusKey.current;
    if (key === null) return true;
    // A flip-armed claim survives until the flip RENDERS. The cursor moves at
    // dispatch but the mode only changes once the settings write lands, so this
    // runs first against the old layout, where "the row is mounted" and "focus
    // is live" are pre-flip facts that must not settle — let alone clear — it.
    if (
      pendingFocusMode.current !== null &&
      viewMode !== pendingFocusMode.current
    )
      return false;
    pendingFocusMode.current = null;
    // A newer cursor move owns focus now, so this claim is stale. A non-cursor
    // claim never names the cursor, so it goes stale only once the cursor moves.
    const arm = pendingFocusCursorAtArm.current;
    if (arm ? cursorKey !== arm.cursor : key !== cursorKey) {
      clearPendingFocus();
      return true;
    }
    // The orphan guard is what keeps a claim from stealing a live control's
    // caret. Focus still sitting in the row the jump was armed from is the one
    // sanctioned exception: it hasn't moved since the gesture, so the claim
    // finishes that gesture instead of interrupting somebody. Without it a jump
    // past the mounted window strands focus on the row the user left, and every
    // later key reads that row instead of the one the cursor names.
    const from = focusedNavRow();
    const atSource =
      pendingFocusSource.current !== null &&
      from !== null &&
      rowKeyOf(from.row) === pendingFocusSource.current;
    if (!focusIsOrphaned() && !atSource) {
      // A flip's claim waits out the dialog holding focus (the palette closing
      // after dispatch) instead of retiring. Its source is dropped, so focus
      // the dialog hands back to that row never reads as "never moved": the
      // kept claim lands only on orphaned focus. Other claims retire as before.
      if (pendingFocusFromFlip.current && waitingFocus() === "dialog") {
        pendingFocusSource.current = null;
        return false;
      }
      clearPendingFocus();
      return true;
    }
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(key)}"]`,
    );
    if (!el) return false;
    clearPendingFocus();
    el.focus();
    return true;
  }
  // The claim as of the latest render, for the view flip's dialog-settle loop:
  // that loop outlives the render that armed it, whose view mode is pre-flip.
  const claimPendingFocusLatest = useEffectEvent(() => claimPendingFocus());

  function moveCursor(row: FlatRow, to: number) {
    activateRow(row, to, false);
    focusRow(rowKeyOf(row));
  }

  // Right expands a collapsed folder, else steps into it; Left collapses an
  // expanded one, else steps out to the parent folder.
  function onArrowRight(row: FlatRow, index: number) {
    if (row.type !== "folder") return;
    if (row.collapsed) {
      toggleFolder(row.section, row.path, true);
      return;
    }
    const child = navRows[index + 1];
    if (child && rowDepth(child) > row.depth) moveCursor(child, index + 1);
  }

  function onArrowLeft(row: FlatRow, index: number) {
    if (row.type === "folder" && !row.collapsed) {
      toggleFolder(row.section, row.path, true);
      return;
    }
    const depth = rowDepth(row);
    for (let i = index - 1; i >= 0; i--) {
      const candidate = navRows[i];
      if (candidate.type === "folder" && candidate.depth < depth) {
        moveCursor(candidate, i);
        return;
      }
    }
  }

  // List mode has no tree to walk, so Left/Right stay the browser's — the gate
  // the focused-row wrapper below reads.
  const arrowLeft = treeMode ? onArrowLeft : undefined;
  const arrowRight = treeMode ? onArrowRight : undefined;
  // Up/Down walk the rows across both sections; Shift extends from the anchor,
  // a plain arrow collapses to the single active row. Focus goes through
  // `focusRow`, not the helper's `rowKey`, whose focus silently skips a target
  // the virtualizer hasn't mounted (a jump from no cursor with the list
  // scrolled away).
  const navKeyDown = listKeyboardNav({
    items: navRows,
    activeIndex: navIndex,
    onActivate: (row, to, shift) => {
      activateRow(row, to, shift);
      focusRow(rowKeyOf(row));
    },
  });

  /** The navigable row DOM focus sits in, resolved from the DOM at use rather
   *  than stored: a focused-row cursor of our own would re-mint the whole
   *  stale-key family the folder-cursor reconciliation exists for. Null unless
   *  focus is inside the list and inside a row (its own controls included). */
  function focusedNavRow(): { row: FlatRow; index: number } | null {
    const list = listRef.current;
    const focused = document.activeElement;
    if (!list || !(focused instanceof HTMLElement) || !list.contains(focused))
      return null;
    const key = focused.closest("[data-row]")?.getAttribute("data-row");
    if (!key) return null;
    const index = navRows.findIndex((r) => rowKeyOf(r) === key);
    return index === -1 ? null : { row: navRows[index], index };
  }

  /** Left/Right fold and walk the tree, so they act on the row FOCUS is on and
   *  live here rather than in the shared hook, which resolves from the cursor: a
   *  bare Tab leaves that behind, and those keys would fold the old selection's
   *  parent, or nothing at all with no file selected. Up/Down stay the hook's and
   *  keep anchoring at the cursor — master's Tab behaviour, unchanged. A focused
   *  tree region swallows both keys whether or not they moved anything, so the
   *  list never scrolls sideways under them. */
  function handleListKeyDown(e: KeyboardEvent) {
    let horizontal: typeof arrowLeft;
    if (e.key === "ArrowLeft") horizontal = arrowLeft;
    else if (e.key === "ArrowRight") horizontal = arrowRight;
    if (horizontal) {
      const hit = focusedNavRow();
      if (hit) {
        e.preventDefault();
        horizontal(hit.row, hit.index);
        return;
      }
    }
    navKeyDown(e);
  }
  // The list element lives in the virtualized child, and every focus restore
  // queries through it — so it comes from the mount itself, never from an event
  // a mouse-only session would never fire. Stable identity: a fresh callback
  // each render would detach and re-attach the node.
  const handleListEl = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
  }, []);

  /** Records which row or header control focus entered, for the advance's
   *  "the list owned focus last" test. */
  function trackListFocusIn(e: FocusEvent) {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest("[data-row]")?.getAttribute("data-row");
    setFocusedRowKey(row ?? null);
    if (row) {
      listFocusRef.current = row;
      return;
    }
    const header = e.target
      .closest("[data-section-header]")
      ?.getAttribute("data-section-header");
    listFocusRef.current = header ? `header:${header}` : null;
  }

  /** Drops the claim when focus moves to a live control outside the list. A
   *  null `relatedTarget` keeps it: an unmount, a window blur, and also a click
   *  on non-focusable content (diff text), after which a later advance with
   *  focus orphaned may pull focus back into the list. Any dialog or menu keeps
   *  it too (`CLAIM_HOLD_SELECTOR`): the marker confirm or the row's own menu
   *  must not cost the row its successor. */
  function trackListFocusOut(e: FocusEvent) {
    const next = e.relatedTarget;
    // Focus leaving the list hands the tab stop back to the cursor. A stale key
    // is harmless anyway: tabStopKey only honors one still in navRows.
    if (!(next instanceof Element) || !e.currentTarget.contains(next))
      setFocusedRowKey(null);
    if (!(next instanceof Element) || !next.isConnected) return;
    if (e.currentTarget.contains(next)) return;
    if (next.closest(CLAIM_HOLD_SELECTOR)) return;
    listFocusRef.current = null;
  }

  /** Focuses a row an advance landed on. The new cursor takes the ordinary
   *  route. Any other row arms a non-cursor claim even when it is mounted and
   *  focused now: the same stage can shift the cursor's index, and the list's
   *  cursor scroll would then carry the row out of the window and drop focus to
   *  <body>; the claim's reveal keeps it in view and re-lands focus. */
  function focusAdvancedRow(key: string, cursorAfter: string | null) {
    if (key === cursorAfter) {
      focusRow(key);
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-row="${CSS.escape(key)}"]`,
    );
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
    deferFocusRow(key, undefined, { cursorAtArm: cursorAfter });
  }

  /** The same, for a target the filter or a folded folder hides: the silent
   *  tabIndex=-1 span above the list takes focus instead — never `landingRef`,
   *  which resolves to the tree-view toggle while the toolbar is up, where the
   *  next Space would flip the saved view mode. A target inside a collapsed
   *  section (or, with none, a collapsed `fallbackSection`) lands on that
   *  section's toggle instead. True when a row or toggle takes focus (either
   *  announces itself), false for the landing. */
  function focusAdvanceTarget(
    key: string | null,
    cursorAfter: string | null,
    fallbackSection: ChangesSection | null,
  ): boolean {
    const landing = advanceLanding(
      key,
      navRows.map(rowKeyOf),
      collapsedSections,
      fallbackSection,
    );
    if (landing.kind === "row") {
      focusAdvancedRow(landing.key, cursorAfter);
      return true;
    }
    if (landing.kind === "toggle") {
      // Unmounted when the virtualizer has scrolled the header away.
      const toggle = listRef.current?.querySelector<HTMLElement>(
        `[data-section-toggle="${landing.section}"]`,
      );
      if (toggle) {
        toggle.focus();
        return true;
      }
    }
    markerLandingRef.current?.focus();
    return false;
  }
  // The landing as of the latest render, for the advance's focus plans: one
  // that waits out a dialog runs frames later and must aim at the rows (and
  // collapsed sections) on screen then, not those of the transition's render.
  const focusAdvanceTargetLatest = useEffectEvent(
    (
      key: string | null,
      cursorAfter: string | null,
      fallbackSection: ChangesSection | null,
    ) => focusAdvanceTarget(key, cursorAfter, fallbackSection),
  );

  // The status transition: a tracked row (the selection, and independently the
  // row focus sits on) that left its section opens the next file in its place —
  // a REACTIVE pick, so it writes through the non-bumping store routes. A layout
  // effect: the successor lands in the same pass, so neither a cursor-less list
  // nor the resting copy paints between the two files. Keyed on the read's
  // IDENTITY, so a no-change poll and an <Activity> replay write nothing; a
  // selection naming an absent row against an unchanged read still clears.
  const prevStatus = useRef<{
    data: RepoStatus | undefined;
    oid: string | null;
    updatedAt: number;
    repoPath: string;
  }>({
    data: status.data,
    oid: status.data?.branch.oid ?? null,
    updatedAt: status.dataUpdatedAt,
    repoPath,
  });
  // The previous commit's on-screen file order and section headers, refreshed by
  // the no-deps layout effect declared AFTER this one: declaration order is what
  // lets this effect read the order the user last saw.
  const prevNav = useRef<{
    keys: string[];
    rowKeys: string[];
    hadStaged: boolean;
    hadUnstaged: boolean;
  }>({ keys: [], rowKeys: [], hadStaged: false, hadUnstaged: false });
  const onStatusTransition = useEffectEvent(
    (
      data: RepoStatus | undefined,
      updatedAt: number,
      selected: typeof selectedFile,
      repo: string,
    ) => {
      const prev = prevStatus.current;
      const walk = useConflictResolve.getState();
      const walkActive = walk.activePath !== null && walk.scopePath === repo;
      // The cross-repo reset owns a repo switch; only resync. Switching back
      // restores the cached read's identity, so the old note must not return.
      if (prev.repoPath !== repo) {
        transitionGen.current += 1;
        prevStatus.current = {
          data,
          oid: data?.branch.oid ?? null,
          updatedAt,
          repoPath: repo,
        };
        pendingLeaveKeys.current.clear();
        clearPendingFocus();
        walkSeen.current = walkActive;
        setAdvanceNote({ text: "", seq: 0, read: undefined });
        return;
      }
      // A read gone missing keeps the last one, which the next read compares
      // against (prevNav holds the order the user last saw meanwhile).
      if (data === undefined) return;
      // Any completed fetch settles the toggles that were waiting on one.
      if (updatedAt !== prev.updatedAt) pendingLeaveKeys.current.clear();
      if (data === prev.data || prev.data === undefined) {
        prevStatus.current = {
          data,
          oid: data.branch.oid,
          updatedAt,
          repoPath: repo,
        };
        if (selected && !hasSide(data.entries, selected.path, selected.staged))
          clearSelectedFile();
        return;
      }
      const prevEntries = prev.data.entries;
      const nowEntries = data.entries;
      prevStatus.current = {
        data,
        oid: data.branch.oid,
        updatedAt,
        repoPath: repo,
      };
      transitionGen.current += 1;
      const gen = transitionGen.current;
      const headMoved = prev.oid !== data.branch.oid;
      const walkWasActive = walkSeen.current;
      walkSeen.current = walkActive;
      const prevKeys = prevNav.current.keys;
      // A key that wasn't in its section before didn't LEAVE it: plain clear.
      const decide = (key: string) => {
        const { staged, path } = splitFileKey(key);
        const stillInSection = hasSide(nowEntries, path, staged);
        if (!stillInSection && !hasSide(prevEntries, path, staged))
          return "clear";
        return pruneDecision({
          stillInSection,
          presentInOther: hasSide(nowEntries, path, !staged),
          headMoved,
          walkActive,
          walkWasActive,
        });
      };
      const focusNow = waitingFocus();
      // A live control outside the list holds focus (reached through <body> or
      // a dialog, so no focusout cleared the claim): the list no longer owns it.
      if (
        focusNow === "other" &&
        !listRef.current?.contains(document.activeElement)
      )
        listFocusRef.current = null;
      const focusKey = listFocusRef.current;
      // Focus will land on the list's pick: it is on the row that left, on
      // nobody, or in a dialog whose focus return is about to orphan it.
      const landable = (key: string) =>
        focusNow === "dialog" || focusLeavingRow(key);
      let lead: { key: AdvanceLead; path: string } | null = null;
      let shownPath: string | null = null;
      let focusPlan: (() => boolean) | null = null;
      let selectionCleared = false;
      let cursorAfter = cursorKey;

      if (selected) {
        const key = keyOf(selected.path, selected.staged);
        const outcome = decide(key);
        if (outcome === "clear") {
          clearSelectedFile();
          selectionCleared = true;
          cursorAfter = activeFolderKey;
        } else if (outcome === "advance") {
          const next = nextFileKey(prevKeys, key, advanceEligible);
          const nextSide = next === null ? null : splitFileKey(next);
          const nextEntry =
            nextSide &&
            nowEntries.find(
              (e) =>
                e.path === nextSide.path &&
                (nextSide.staged ? e.staged !== null : e.unstaged !== null),
            );
          if (next !== null && nextSide && nextEntry) {
            // ONE write from file A to file B, never through null.
            advanceSelectedFile({
              path: nextEntry.path,
              staged: nextSide.staged,
              untracked: nextEntry.unstaged === "untracked",
            });
            noteOwnShownWrite();
            selectionGen.current += 1;
            setSelectedKeys((keys) => selectionAfterAdvance(keys, key, next));
            setAnchorKey(next);
            const cursor = cursorAfterAdvance(
              activeFolderKey,
              activeFolderKey !== null &&
                navRows.some((r) => rowKeyOf(r) === activeFolderKey),
              next,
            );
            setActiveFolderKey(cursor.folderCursor);
            cursorAfter = cursor.cursor;
            shownPath = nextEntry.path;
          } else {
            clearSelectedFile();
            selectionCleared = true;
            cursorAfter = activeFolderKey;
          }
          lead = {
            key: selected.staged ? "staged" : "unstaged",
            path: selected.path,
          };
          if (focusKey === key && landable(key)) {
            // The last file follows itself into the other section, focused but
            // not selected.
            const target = next ?? keyOf(selected.path, !selected.staged);
            focusPlan = () =>
              focusAdvanceTargetLatest(target, cursorAfter, null);
          }
        }
      }

      if (
        focusKey !== null &&
        isFileKey(focusKey) &&
        focusKey !== activeKey &&
        landable(focusKey)
      ) {
        if (decide(focusKey) === "advance") {
          const { staged, path } = splitFileKey(focusKey);
          lead = { key: staged ? "staged" : "unstaged", path };
          const target =
            nextFileKey(prevKeys, focusKey, advanceEligible) ??
            keyOf(path, !staged);
          focusPlan = () => focusAdvanceTargetLatest(target, cursorAfter, null);
        }
      } else if (
        focusKey?.startsWith("header:") &&
        !headMoved &&
        !walkActive &&
        focusNow !== "other"
      ) {
        // A focused Stage all / Unstage all whose section emptied by moving its
        // files across: focus takes the other section's first row.
        const staged = focusKey === "header:staged";
        const had = staged
          ? prevNav.current.hadStaged
          : prevNav.current.hadUnstaged;
        const has = (staged ? stagedEntries : unstagedEntries).length > 0;
        const movedAcross = prevEntries.some(
          (e) =>
            (staged ? e.staged !== null : e.unstaged !== null) &&
            hasSide(nowEntries, e.path, !staged),
        );
        if (had && !has && movedAcross) {
          lead = {
            key: staged ? "header:staged" : "header:unstaged",
            path: "",
          };
          const otherPrefix = staged ? "unstaged:" : "staged:";
          const target =
            navFileKeys.find(
              (k) => k.startsWith(otherPrefix) && advanceEligible.has(k),
            ) ?? null;
          // A collapsed other section has no rows: its toggle takes focus.
          const other = staged ? "unstaged" : "staged";
          focusPlan = () =>
            focusAdvanceTargetLatest(target, cursorAfter, other);
        }
      } else if (
        focusKey !== null &&
        !headMoved &&
        !walkActive &&
        landable(focusKey) &&
        prevNav.current.rowKeys.includes(focusKey)
      ) {
        // A focused folder row whose files all left its section. A row still at
        // or under its directory means a re-key instead, which the folder-cursor
        // backstop owns.
        const folder = parseFolderRowKey(focusKey);
        const nowRowKeys = navRows.map(rowKeyOf);
        const survives = (key: string) => {
          if (folder === null) return false;
          const sub = parseFolderRowKey(key);
          const row = sub
            ? { staged: sub.section === "staged", path: sub.path }
            : isFileKey(key)
              ? splitFileKey(key)
              : null;
          return (
            row !== null &&
            row.staged === (folder.section === "staged") &&
            (row.path === folder.path || row.path.startsWith(`${folder.path}/`))
          );
        };
        if (folder && !nowRowKeys.some(survives)) {
          // No row at or under the folder survived, so any same-side
          // descendant still in the new read is one the filter hides.
          const hiddenLeft = entriesUnderFolder(
            nowEntries.filter(
              (e) =>
                (folder.section === "staged" ? e.staged : e.unstaged) !== null,
            ),
            (e) => e.path,
            folder.path,
          ).length;
          lead = {
            key: `${hiddenLeft > 0 ? "folder-hidden" : "folder"}:${folder.section}`,
            path: folder.path,
          };
          const target = rowAfterFolderLeaves(
            prevNav.current.rowKeys,
            focusKey,
            nowRowKeys,
          );
          // The cursor moves here, so the claim's `cursorAtArm` names the row
          // the cursor will actually be on.
          if (target !== null && parseFolderRowKey(target)) {
            setActiveFolderKey(target);
            cursorAfter = target;
          } else if (activeFolderKey === focusKey) {
            setActiveFolderKey((cur) => (cur === focusKey ? null : cur));
            if (cursorAfter === focusKey)
              cursorAfter = selectionCleared ? null : activeKey;
          }
          // With no row left to take focus, a collapsed other section's toggle.
          const other = folder.section === "staged" ? "unstaged" : "staged";
          focusPlan = () =>
            focusAdvanceTargetLatest(target, cursorAfter, other);
        }
      }

      // Without a focused row to announce itself: the file now shown, the file
      // the selection kept, or the resting pane only when nothing is selected.
      let restTail: AdvanceTail = "none";
      if (shownPath !== null) restTail = "shown";
      else if (selected !== null && !selectionCleared) restTail = "kept";
      const announce = (tail: AdvanceTail) => {
        if (lead === null || transitionGen.current !== gen) return;
        const text =
          ADVANCE_LEADS[lead.key](lead.path) +
          ADVANCE_TAILS[tail](shownPath ?? "", nowEntries.length);
        setAdvanceNote((n) => ({ text, seq: n.seq + 1, read: data }));
      };
      // Focus lands first; the announcement follows a frame later so the
      // focused control's own utterance can't cut the polite one off.
      const land = (plan: () => boolean) => {
        const onRow = plan();
        requestAnimationFrame(() => announce(onRow ? "focused" : restTail));
      };
      if (focusPlan === null) announce(restTail);
      else if (focusNow !== "dialog") land(focusPlan);
      else {
        // A dialog's exit still holds focus and is about to hand it back to the
        // row that left: claim once that return has orphaned it.
        const plan = focusPlan;
        const deadline = performance.now() + DIALOG_CLAIM_MS;
        const step = () => {
          if (transitionGen.current !== gen) return;
          const verdict = dialogClaimStep(
            waitingFocus(),
            performance.now(),
            deadline,
          );
          if (verdict === "wait") requestAnimationFrame(step);
          else if (verdict === "claim") land(plan);
          else announce(restTail);
        };
        requestAnimationFrame(step);
      }
    },
  );
  useLayoutEffect(() => {
    onStatusTransition(
      status.data,
      status.dataUpdatedAt,
      selectedFile,
      repoPath,
    );
  }, [status.data, status.dataUpdatedAt, selectedFile, repoPath]);
  // Every commit, after the transition effect above has read the previous one.
  // A missing read leaves the last on-screen order in place for the next one.
  useLayoutEffect(() => {
    if (status.data === undefined) return;
    prevNav.current = {
      keys: navFileKeys,
      rowKeys: navRows.map(rowKeyOf),
      hadStaged: stagedEntries.length > 0,
      hadUnstaged: unstagedEntries.length > 0,
    };
  });
  // Marks a walk seen between status reads, since one can open and close (its
  // last file staged) without a read landing while it was open.
  useEffect(
    () =>
      useConflictResolve.subscribe((s) => {
        if (s.activePath !== null && s.scopePath === repoPath)
          walkSeen.current = true;
      }),
    [repoPath],
  );
  // Prune multi-selection keys whose OWN side has left the working tree
  // (staged, committed, discarded, etc.), so counts and highlights stay
  // accurate and the rest of a multi-selection survives a single row's move.
  useEffect(() => {
    if (!status.data) return;
    const live = new Set<string>();
    for (const e of status.data.entries) {
      if (e.staged !== null) live.add(keyOf(e.path, true));
      if (e.unstaged !== null) live.add(keyOf(e.path, false));
    }
    setSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [status.data]);
  // A shown file the panel didn't write (the conflict walk's starts and moves)
  // takes the multi-selection with it, so the highlight marks the file on
  // screen. Keyed on the shown file alone: a selection-only change, a section
  // collapse included, never runs it.
  const followShownFile = useEffectEvent(
    (prev: SelectedFile | null, next: SelectedFile | null) => {
      const follow = selectionFollowingShownFile({
        prevKey: prev ? keyOf(prev.path, prev.staged) : null,
        nextKey: next ? keyOf(next.path, next.staged) : null,
        panelWrote: next === ownShownWrite.current,
        visibleKeys: navFileKeys,
      });
      if (follow === null) return;
      selectionGen.current += 1;
      setSelectedKeys(follow.keys);
      setAnchorKey(follow.anchor);
    },
  );
  useEffect(() => {
    const prev = shownSeen.current;
    shownSeen.current = selectedFile;
    followShownFile(prev, selectedFile);
  }, [selectedFile]);
  // Collapse state and the folder cursor name directories of the repo they were
  // made in. Guarded on the path actually changing: <Activity> replays effects
  // on every tab show, and an unguarded reset would drop the user's collapses.
  const prevRepo = useRef(repoPath);
  useEffect(() => {
    if (prevRepo.current === repoPath) return;
    prevRepo.current = repoPath;
    setCollapsedFolders(new Set());
    setCollapsedSections(new Set());
    setActiveFolderKey(null);
  }, [repoPath]);
  // The re-keyed folder row the backstop lands focus on once a closing dialog
  // hands focus back, and the stale key it replaced; null = no wait running.
  const folderClaimTarget = useRef<{ key: string; from: string } | null>(null);
  // The live cursor and rows for that wait, which outlives the render that
  // armed it.
  const activeFolderKeyLatest = useEffectEvent(() => activeFolderKey);
  const folderRowListedLatest = useEffectEvent((key: string) =>
    flatRows.some((r) => rowKeyOf(r) === key),
  );
  // The backstop for a folder cursor whose row was re-keyed: whenever
  // `activeFolderKey` stops resolving, it is re-keyed to the surviving row or
  // cleared. Every re-key source lands here — external status churn changing
  // compaction, the toggles, any path added later; the toggle-site
  // reconciliations remain the synchronous fast path, which usually prevents the
  // orphan window entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cursor key stopped resolving
  useEffect(() => {
    if (activeFolderKey === null || navIndex !== -1) return;
    const parsed = parseFolderRowKey(activeFolderKey);
    if (!parsed) return;
    const { section, path: dir } = parsed;
    const staleKey = activeFolderKey;
    // A collapsed section lists no folder rows, so there is nothing to re-key to.
    if (collapsedSections.has(section)) {
      setActiveFolderKey((cur) => (cur === staleKey ? null : cur));
      return;
    }
    // A re-key only ever extends the chain downward (a shortened chain keeps its
    // key), so the survivor is the first row at or under the stale directory.
    const nextKey = findFolderRowKey(
      section,
      collapsedIn(section),
      (p) => p === dir || p.startsWith(`${dir}/`),
    );
    // Null = the folder's files are gone entirely; the cursor just clears.
    // Compare-and-set: the status transition's folder arm may already have
    // moved the cursor in a layout effect this passive effect runs behind.
    setActiveFolderKey((cur) => (cur === staleKey ? nextKey : cur));
    // Post-commit the old row is already unmounted, so orphaned focus is the
    // whole signal — a caret parked in the filter input during a background
    // refresh must stay where it is.
    if (nextKey !== null && focusIsOrphaned()) {
      // Landed focus retires any wait still aimed at an older survivor.
      folderClaimTarget.current = null;
      focusRow(nextKey);
    }
    // A closing confirm will hand focus back to the dead row: land on the
    // survivor once that return orphans it. No cleanup cancels the loop (this
    // effect re-runs on its own cursor write); a newer re-key re-aims it.
    if (nextKey !== null && waitingFocus() === "dialog") {
      const looping = folderClaimTarget.current !== null;
      folderClaimTarget.current = { key: nextKey, from: staleKey };
      if (looping) return;
      const firedOn = repoPath;
      // Timed from the dialog's close, not the re-key: a confirm stays open as
      // long as the user reads it.
      let deadline: number | null = null;
      const step = () => {
        const target = folderClaimTarget.current;
        // The cursor reads `from` until the re-key's write commits, and null
        // once an advance cleared it while the row stays listed (landing focus
        // moves it back); any other key means a newer move left this stale.
        const live = activeFolderKeyLatest();
        if (
          target === null ||
          (live !== target.key &&
            live !== target.from &&
            !(live === null && folderRowListedLatest(target.key))) ||
          useUiStore.getState().repoPath !== firedOn
        ) {
          folderClaimTarget.current = null;
          return;
        }
        const waiting = waitingFocus();
        // Nothing can land while the dialog stays open, so poll slowly there.
        if (waiting === "dialog" && focusInOpenPopup()) {
          deadline = null;
          window.setTimeout(step, DIALOG_HOLD_POLL_MS);
          return;
        }
        deadline ??= performance.now() + DIALOG_CLAIM_MS;
        const verdict = dialogClaimStep(waiting, performance.now(), deadline);
        if (verdict === "wait") {
          requestAnimationFrame(step);
          return;
        }
        folderClaimTarget.current = null;
        if (verdict === "claim") focusRow(target.key);
      };
      requestAnimationFrame(step);
    }
  }, [activeFolderKey, navIndex]);
  const mutating = stage.isPending || unstage.isPending || checking;
  const onError = (e: unknown) => toastError(e);

  function toggleKind(kind: FilterKind, on: boolean) {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }

  function select(entry: FileEntry, staged: boolean) {
    selectFile({
      path: entry.path,
      staged,
      untracked: entry.unstaged === "untracked",
    });
    noteOwnShownWrite();
  }

  /** Records the shown file the panel just wrote. The store's set is
   *  synchronous, so the read is the panel's own object; every panel write of
   *  a file calls this right after, or the follow effect would treat it as an
   *  outside move. */
  function noteOwnShownWrite() {
    ownShownWrite.current = useUiStore.getState().selectedFile;
  }

  // Click selection with modifier support: plain = single, Ctrl/Cmd = toggle,
  // Shift = range from the anchor. The clicked row always becomes active so
  // its diff shows (via `select`).
  function handleSelect(
    entry: FileEntry,
    staged: boolean,
    mods: { ctrlOrMeta: boolean; shift: boolean },
  ) {
    const key = keyOf(entry.path, staged);
    select(entry, staged);
    setActiveFolderKey(null);
    if (mods.shift && anchorKey) {
      const keys = navRows.map(rowKeyOf);
      const a = keys.indexOf(anchorKey);
      const b = keys.indexOf(key);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        // Folder rows contribute no keys: a range spans the files it covers.
        selectionGen.current += 1;
        setSelectedKeys(
          new Set(
            navRows
              .slice(lo, hi + 1)
              .filter((r) => r.type === "file")
              .map(rowKeyOf),
          ),
        );
        return;
      }
    }
    if (mods.ctrlOrMeta) {
      selectionGen.current += 1;
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorKey(key);
      return;
    }
    selectionGen.current += 1;
    setSelectedKeys(new Set([key]));
    setAnchorKey(key);
  }

  /** Keeps the folder cursor off a row focus has left — the arrow and view-flip
   *  arms act on it. A folder row parks it (pure cursor state); a file row only
   *  CLEARS it, because a file cursor IS the shown-diff selection and selecting
   *  on focus would make Tab clobber the open diff. Delegated over the list, so
   *  no row kind can miss it and a row's own controls count too (React's
   *  `onFocus` is `focusin`, which bubbles); focus outside a row — the filter, a
   *  palette dispatch — must leave the cursor where the flip arms read it. */
  function handleRowFocus(e: FocusEvent) {
    if (!(e.target instanceof HTMLElement)) return;
    const key = e.target.closest("[data-row]")?.getAttribute("data-row");
    if (!key || key === cursorKey) return;
    const row = navRows.find((r) => rowKeyOf(r) === key);
    if (!row) return;
    setActiveFolderKey(row.type === "folder" ? key : null);
    // Clearing the folder cursor moves it to the shown file, which a pointer
    // press can sit far from. An arrow move has already shown the row it
    // focuses, so its cursor lands here and keeps its scroll.
    const shown = useUiStore.getState().selectedFile;
    if (
      row.type === "file" &&
      activeFolderKey !== null &&
      (shown === null || keyOf(shown.path, shown.staged) !== key)
    )
      setFocusCursorMove({});
  }

  /** Every stage route's one `git add` (no await unless a target is conflicted);
   *  a file still holding markers asks first, and a decline stages NOTHING. Only
   *  the captured targets and repo are used past the prompt, and a repo switch
   *  meanwhile refuses the stage, since the mutation would retarget. Resolves
   *  whether it staged. */
  async function stageGuarded(targets: FileEntry[]): Promise<boolean> {
    const pathspecs = targets.map((e) => literalPathspec(e.path));
    const conflicted = targets.filter(isConflictedEntry);
    if (conflicted.length === 0) {
      await stage.mutateAsync(pathspecs);
      return true;
    }
    // The ref, not the disables, is the guarantee: the menu items never read
    // `mutating`, so they skip the disables and get the toast instead. Refused
    // before the try, so the first check's flags survive.
    if (checkingRef.current) {
      toast.info(MARKER_CHECK_PENDING);
      return false;
    }
    const firedOn = repoPath;
    // `checking` drops in the same tick the stage starts, with no await between
    // it and `stage.isPending` taking over the disables.
    let staging: Promise<unknown>;
    checkingRef.current = true;
    setChecking(true);
    try {
      const ok = await confirmMarkerStage(
        firedOn,
        conflicted,
        targets.length > 1,
      );
      if (
        !ok ||
        refuseIfSwitched(
          firedOn,
          "nothing was staged",
          "before the stage started",
        )
      )
        return false;
      staging = stage.mutateAsync(pathspecs);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
    await staging;
    return true;
  }

  // Toggle one file's staged state — the row's +/- button and Space, and the
  // single menu.
  function handleToggle(entry: FileEntry, staged: boolean) {
    const key = keyOf(entry.path, staged);
    // A toggle that already landed, on a row the status read hasn't moved yet:
    // a second press would act on the stale row. Silent, like the disabled
    // button. Added only on success, so a declined marker confirm (which moves
    // no row, and so would never clear it) leaves the row live.
    if (pendingLeaveKeys.current.has(key)) return;
    // The repo the press landed in: a settle after a switch must not deaden
    // a same-named row in the repository now open.
    const firedOn = repoPath;
    const markLeaving = () => {
      if (landedIn(firedOn).live) pendingLeaveKeys.current.add(key);
    };
    if (staged) {
      void unstage
        .mutateAsync(unstagePaths(entry))
        .then(markLeaving)
        .catch(onError);
      return;
    }
    // Fire-time guard: the affordances are already disabled, but a later call
    // site must not reach a `git add` that dies reading the device.
    if (!canStage(entry)) return;
    void stageGuarded([entry])
      .then((ok) => {
        if (ok) markLeaving();
      })
      .catch(onError);
  }

  /** The key of the first folder row whose path satisfies `match` in `section`'s
   *  tree under `collapsed`. The tree is pure, so a not-yet-rendered arrangement
   *  can be asked directly; rows come in render order, so "first" is the
   *  outermost match. Null = no such row. */
  function findFolderRowKey(
    section: "staged" | "unstaged",
    collapsed: Set<string>,
    match: (path: string) => boolean,
  ): string | null {
    const sectionEntries =
      section === "staged" ? stagedEntries : unstagedEntries;
    const row = flattenPathTree(sectionEntries, (e) => e.path, collapsed).find(
      (r) => r.kind === "folder" && match(r.path),
    );
    return row && row.kind === "folder"
      ? `folder:${section}:${row.path}`
      : null;
  }

  /** The row key `dirPath` carries once `nextCollapsed` applies. Expanding a
   *  node re-enables compaction THROUGH it, which re-keys its row to the deeper
   *  compacted path. Null = no folder row names this directory any more. */
  function folderKeyAfterToggle(
    section: "staged" | "unstaged",
    dirPath: string,
    nextCollapsed: Set<string>,
  ): string | null {
    // The node's own row precedes every descendant, so the first row at or under
    // dirPath is the (possibly re-keyed) chain this directory now lives in.
    return findFolderRowKey(
      section,
      nextCollapsed,
      (path) => path === dirPath || path.startsWith(`${dirPath}/`),
    );
  }

  // Collapse or expand one directory. Collapsing drops the hidden descendants
  // from the multi-selection: a collapsed folder must never hold a
  // selectable-but-invisible row. The shown diff deliberately survives being
  // hidden, exactly as it does behind the text filter.
  function toggleFolder(
    section: "staged" | "unstaged",
    dirPath: string,
    /** The cursor belongs on this row after the toggle (click / arrow routes),
     *  even when it sat elsewhere before. */
    cursorFollows = false,
  ) {
    const key = `${section}:${dirPath}`;
    const rowKey = `folder:${key}`;
    const collapsing = !collapsedFolders.has(key);
    const cursorHere = cursorFollows || activeFolderKey === rowKey;
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (collapsing) next.add(key);
      else next.delete(key);
      return next;
    });
    if (collapsing) {
      // A collapsing row keeps its key — compaction never runs through a
      // collapsed node — so the cursor and its focus stay put.
      if (cursorHere) setActiveFolderKey(rowKey);
      setSelectedKeys((prev) => pruneHiddenKeys(prev, [key]));
      return;
    }
    if (!cursorHere) return;
    // Re-key the cursor with the row, or the expanded row unmounts under the
    // focus and every arrow key goes dead. `focusRow` misses the not-yet-mounted
    // row and defers to the pending-focus claim.
    const nextCollapsed = collapsedIn(section);
    nextCollapsed.delete(dirPath);
    const nextKey = folderKeyAfterToggle(section, dirPath, nextCollapsed);
    setActiveFolderKey(nextKey);
    if (nextKey !== null) focusRow(nextKey);
  }

  // Clicking a folder both toggles it and parks the cursor there.
  function handleFolderActivate(row: FolderRow) {
    toggleFolder(row.section, row.path, true);
  }

  // Collapse or expand a whole section. Its rows leave navigation, so the
  // selection, a folder cursor and a pending focus claim inside it go too; the
  // shown diff survives, as it does behind a collapsed folder.
  function toggleSection(section: ChangesSection) {
    const collapsing = !collapsedSections.has(section);
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (collapsing) next.add(section);
      else next.delete(section);
      return next;
    });
    if (!collapsing) return;
    setSelectedKeys((prev) =>
      pruneCollapsedSectionKeys(prev, new Set([section])),
    );
    if (activeFolderKey !== null && rowKeySection(activeFolderKey) === section)
      setActiveFolderKey(null);
    const claim = pendingFocusKey.current;
    if (claim !== null && rowKeySection(claim) === section) clearPendingFocus();
  }

  /** Lands a view flip's focus once the dialog that held it at dispatch (the
   *  palette) hands it back, mirroring the advance's dialog wait: the armed claim
   *  if there is one, else the toggle that owns the swap. Only orphaned focus is
   *  ever taken; live focus elsewhere, a repo switch, a newer claim or the
   *  deadline retires the loop, clearing only the claim it was started for.
   *  `armed` is the token of the claim THIS flip armed (null: none), never a
   *  read of whatever claim happens to be pending. */
  function settleFlipFocusAfterDialog(armed: object | null) {
    const firedOn = repoPath;
    const deadline = performance.now() + DIALOG_CLAIM_MS;
    const ownClaim = () =>
      armed !== null && pendingFocusToken.current === armed;
    const drop = () => {
      if (ownClaim()) clearPendingFocus();
    };
    const step = () => {
      if (useUiStore.getState().repoPath !== firedOn) return;
      if (armed !== null && !ownClaim()) return;
      const verdict = dialogClaimStep(
        waitingFocus(),
        performance.now(),
        deadline,
      );
      if (verdict === "wait") requestAnimationFrame(step);
      else if (verdict === "drop") drop();
      else if (armed === null) viewToggleRef.current?.focus();
      else if (!claimPendingFocusLatest()) {
        // The claimed row may mount, or the flip's settings write land, a frame
        // late; orphaned focus never makes dialogClaimStep drop, so the
        // deadline bounds these retries.
        if (performance.now() < deadline) requestAnimationFrame(step);
        else drop();
      }
    };
    requestAnimationFrame(step);
  }

  function toggleViewMode() {
    if (!settings.data) return;
    const nextMode = treeMode ? "list" : "tree";
    // The flat list has no folder rows for a parked cursor to name.
    setActiveFolderKey(null);
    // A flip can unmount the focused row OR merely reorder it out of the
    // virtualized window, and the palette route dispatches with focus still on
    // it — either way focus lands on <body> and the arrow keys go dead. The arms
    // route by cursor: a parked FOLDER cursor exists only leaving tree mode; a
    // file cursor a collapse will swallow exists only entering it; every other
    // surviving file cursor takes the deferred claim last.
    // The palette closes before it dispatches, so its dialog still holds focus
    // here and hands it back only after the flip has re-keyed the rows: every arm
    // treats that as landable and the settle loop below lands it.
    const inDialog = waitingFocus() === "dialog";
    let armed: object | null = null;
    let swallowedByCollapse = false;
    // A selection inside a collapsed section has no row in either layout, so
    // no arm claims it; where focus needs a home the view toggle takes it
    // (under the palette, through the settle loop).
    const selectionHidden =
      selectedFile !== null &&
      collapsedSections.has(selectedFile.staged ? "staged" : "unstaged");
    if (treeMode) {
      // Leaving tree mode: the folder rows go, so a cursor parked on one takes
      // the file row the list keeps, or the control that owns the swap. The
      // claim is DEFERRED: the file row is mounted in the old layout, but the
      // flip's reorder can carry it out of the window — focusing it now would
      // arm nothing for that exit.
      if (
        activeFolderKey !== null &&
        (inDialog || focusLeavingRow(activeFolderKey))
      ) {
        if (activeKey !== null && !selectionHidden)
          armed = deferFocusRow(activeKey, nextMode);
        else if (!inDialog) viewToggleRef.current?.focus();
      }
    } else {
      // Collapse state outlives list mode by design, so entering tree mode can
      // hide rows selected while they were flat — prune them as a collapse does.
      setSelectedKeys((prev) => pruneHiddenKeys(prev, collapsedFolders));
      // The same collapse can swallow the focused file row: park the cursor on
      // the folder that now stands for it. That folder row cannot exist before
      // the flip, so the claim is armed for it outright.
      if (selectedFile && activeKey !== null && !selectionHidden) {
        const section = selectedFile.staged ? "staged" : "unstaged";
        const collapsed = collapsedIn(section);
        swallowedByCollapse = [...collapsed].some((dir) =>
          selectedFile.path.startsWith(`${dir}/`),
        );
        if (swallowedByCollapse && (inDialog || focusLeavingRow(activeKey))) {
          const swallowing = findFolderRowKey(
            section,
            collapsed,
            (path) =>
              collapsed.has(path) && selectedFile.path.startsWith(`${path}/`),
          );
          if (swallowing !== null) {
            setActiveFolderKey(swallowing);
            armed = deferFocusRow(swallowing, nextMode);
          } else if (!inDialog) viewToggleRef.current?.focus();
        }
      }
    }
    // Both directions re-sort the rows (tree mode puts folders first), so a file
    // cursor whose row survives visible can still leave the window. Its row is
    // mounted right now, so the claim is armed directly for the post-flip
    // window; if the row never moves, focus survives and the claim no-ops.
    if (
      !swallowedByCollapse &&
      !selectionHidden &&
      activeFolderKey === null &&
      activeKey !== null &&
      (inDialog || focusLeavingRow(activeKey))
    )
      armed = deferFocusRow(activeKey, nextMode);
    if (inDialog) settleFlipFocusAfterDialog(armed);
    void saveSettings
      .mutateAsync({ ...settings.data, changesViewMode: nextMode })
      .catch(() => undefined);
  }

  // Single-file ignore / untrack (the per-row menu); the bulk equivalents are
  // ignoreSelected / untrackSelected below.
  async function ignoreOne(pattern: string, label: string) {
    try {
      const added = await appendIgnore.mutateAsync([pattern]);
      toast.success(
        added === 0
          ? `"${label}" is already in .gitignore`
          : `Added "${label}" to .gitignore`,
      );
    } catch (e) {
      onError(e);
    }
  }
  async function aiExcludeOne(patterns: string[], label: string) {
    try {
      const added = await appendAiIgnore.mutateAsync(patterns);
      toast.success(
        added === 0
          ? `"${label}" is already in .gitdesktop/aiignore`
          : `Added "${label}" to .gitdesktop/aiignore`,
      );
    } catch (e) {
      onError(e);
    }
  }
  async function untrackOne(
    pathspec: string,
    ignorePattern: string,
    label: string,
  ) {
    try {
      await untrack.mutateAsync({
        pathspecs: [pathspec],
        ignorePatterns: [ignorePattern],
      });
      toast.success(`Untracked ${label} — kept on disk, added to .gitignore`);
    } catch (e) {
      onError(e);
    }
  }

  // Right-click anywhere in the list: act on the row under the cursor, or fall
  // back to the whole-tree menu for section headers and blank space.
  function handleContextMenu(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest("[data-row]");
    const key = rowEl?.getAttribute("data-row");
    const folder = key ? parseFolderRowKey(key) : null;
    if (folder) {
      setMenuTarget({ kind: "folder", ...folder, repo: repoPath });
      return;
    }
    if (key && isFileKey(key)) {
      const staged = key.startsWith("staged:");
      const path = key.slice(key.indexOf(":") + 1);
      const entry = rowEntry(entries, path, staged);
      if (entry) {
        setMenuTarget({ kind: "row", entry, staged });
        return;
      }
    }
    setMenuTarget({ kind: "global" });
  }

  function stageAll() {
    void stageGuarded(stageableUnstaged).catch(onError);
  }

  function unstageAll() {
    void unstage
      .mutateAsync(stagedEntries.flatMap(unstagePaths))
      .catch(onError);
  }

  // A folder's stage and unstage act on its SHOWN files (the row's "(N)"),
  // resolved now from the live lists, and only on the side the folder sits in.
  // `repo` is where the gesture started (the menu's right-click, or the
  // palette's fire); the folder key latches like handleToggle's file key.
  function stageFolderIn(dir: string, repo: string) {
    const key = `folder:unstaged:${dir}`;
    if (pendingLeaveKeys.current.has(key)) return;
    if (refuseIfSwitched(repo, "nothing was staged")) return;
    const targets = entriesUnderFolder(
      unstagedEntries,
      (e) => e.path,
      dir,
    ).filter(canStage);
    if (targets.length === 0) return;
    void stageGuarded(targets)
      .then((ok) => {
        if (ok && landedIn(repo).live) pendingLeaveKeys.current.add(key);
      })
      .catch(onError);
  }

  function unstageFolderIn(dir: string, repo: string) {
    const key = `folder:staged:${dir}`;
    if (pendingLeaveKeys.current.has(key)) return;
    if (refuseIfSwitched(repo, "nothing was unstaged")) return;
    const targets = entriesUnderFolder(stagedEntries, (e) => e.path, dir);
    if (targets.length === 0) return;
    void unstage
      .mutateAsync(targets.flatMap(unstagePaths))
      .then(() => {
        if (landedIn(repo).live) pendingLeaveKeys.current.add(key);
      })
      .catch(onError);
  }

  // The palette's folder actions act on the folder cursor as of the fire.
  const folderCursor =
    treeMode && activeFolderKey !== null
      ? parseFolderRowKey(activeFolderKey)
      : null;
  // Both folder counts below are memoized by hand: the compiler bails on this
  // component, and each is an O(n) walk of lists sized for 20k rows that would
  // otherwise re-run on every render while their inputs hold.
  // primary = what the cursor's Stage/Unstage reaches; Discard leaves
  // conflicted files out, Stash leaves out what the backend won't stash.
  const folderCursorTargets = useMemo(() => {
    const cursor =
      treeMode && activeFolderKey !== null
        ? parseFolderRowKey(activeFolderKey)
        : null;
    if (cursor === null) return { primary: 0, discardable: 0, stashable: 0 };
    const staged = cursor.section === "staged";
    const shown = entriesUnderFolder(
      staged ? stagedEntries : unstagedEntries,
      (e) => e.path,
      cursor.path,
    );
    return {
      primary: staged ? shown.length : shown.filter(canStage).length,
      discardable: staged
        ? 0
        : shown.filter((e) => !isConflictedEntry(e)).length,
      stashable: shown.filter((e) => !staysOutOfStash(e)).length,
    };
  }, [treeMode, activeFolderKey, stagedEntries, unstagedEntries]);

  // The menu's counts for a right-clicked folder, from the same live lists, so
  // a poll while the menu is open updates them. Hidden = same-side files under
  // the folder that the filter leaves out; conflicted = the shown files
  // Discard leaves alone.
  const folderCounts = useMemo((): FolderMenuCounts | null => {
    if (menuTarget?.kind !== "folder") return null;
    const staged = menuTarget.section === "staged";
    const shown = entriesUnderFolder(
      staged ? stagedEntries : unstagedEntries,
      (e) => e.path,
      menuTarget.path,
    );
    const sameSide = entriesUnderFolder(
      entries.filter((e) => (staged ? e.staged : e.unstaged) !== null),
      (e) => e.path,
      menuTarget.path,
    );
    return {
      fileCount: shown.length,
      stageableCount: staged ? 0 : shown.filter(canStage).length,
      hiddenCount: sameSide.length - shown.length,
      conflictedCount: shown.filter(isConflictedEntry).length,
      stashableCount: shown.filter((e) => !staysOutOfStash(e)).length,
    };
  }, [menuTarget, entries, stagedEntries, unstagedEntries]);

  // Bulk stage/unstage act only on the selected rows of their own side: a file
  // with staged and unstaged edits keeps the side the user didn't select.
  async function stageSelected() {
    if (stageableSelected.length === 0) return;
    const gen = selectionGen.current;
    const repo = repoPath;
    try {
      if (await stageGuarded(stageableSelected))
        clearSelectionIfUnchanged(gen, repo);
    } catch (e) {
      onError(e);
    }
  }

  async function unstageSelected() {
    if (bulk.stagedRows.length === 0) return;
    const gen = selectionGen.current;
    const repo = repoPath;
    try {
      await unstage.mutateAsync(bulk.stagedRows.flatMap(unstagePaths));
      clearSelectionIfUnchanged(gen, repo);
    } catch (e) {
      onError(e);
    }
  }

  function requestDiscardSelected() {
    const conflicted = selectedDiscard.conflicted.length;
    if (selectedDiscard.targets.length > 0)
      setDiscardScope({
        kind: "files",
        entries: selectedDiscard.targets,
        repo: repoPath,
        leftAlone: conflicted > 0 ? { hidden: 0, conflicted } : undefined,
      });
  }

  function requestStashSelected() {
    if (bulk.pathEntries.length > 0)
      setStashScope({
        kind: "files",
        entries: bulk.pathEntries,
        repo: repoPath,
        split: bulk.splitPaths.length > 0,
      });
  }

  // A folder's Discard and Stash act on its shown files through the
  // selection's own target assembly, so twins, renames and splits resolve the
  // same way. Hidden = same-side files under it that the filter leaves out.
  function folderActionTargets(section: "staged" | "unstaged", dir: string) {
    const staged = section === "staged";
    const shown = entriesUnderFolder(
      staged ? stagedEntries : unstagedEntries,
      (e) => e.path,
      dir,
    );
    const sameSide = entriesUnderFolder(
      entries.filter((e) => (staged ? e.staged : e.unstaged) !== null),
      (e) => e.path,
      dir,
    );
    const keys = new Set(shown.map((e) => keyOf(e.path, staged)));
    return {
      rows: bulkRowTargets(keys, entries),
      hidden: sameSide.length - shown.length,
    };
  }

  // `repo` is where the gesture started; the confirm dialog is the double-fire
  // guard, so no folder key latches here.
  function requestDiscardFolder(dir: string, repo: string) {
    if (refuseIfSwitched(repo, "nothing was discarded")) return;
    const { rows, hidden } = folderActionTargets("unstaged", dir);
    const { targets, conflicted } = excludeConflicted(rows.unstagedRows);
    if (targets.length === 0) return;
    setDiscardScope({
      kind: "files",
      entries: targets,
      repo,
      folder: dir,
      leftAlone:
        hidden > 0 || conflicted.length > 0
          ? { hidden, conflicted: conflicted.length }
          : undefined,
    });
  }

  function requestStashFolder(
    section: "staged" | "unstaged",
    dir: string,
    repo: string,
  ) {
    if (refuseIfSwitched(repo, "nothing was stashed")) return;
    const { rows, hidden } = folderActionTargets(section, dir);
    if (rows.pathEntries.length === 0) return;
    setStashScope({
      kind: "files",
      entries: rows.pathEntries,
      repo,
      split: rows.splitPaths.length > 0,
      folder: dir,
      leftAlone: hidden > 0 ? { hidden, conflicted: 0 } : undefined,
    });
  }

  // Bulk ignore: add a `/path` line per selected file (any kind), one per path
  // so a split file can't read as a false partial. The Rust side skips lines
  // already present.
  async function ignoreSelected() {
    if (bulk.pathEntries.length === 0) return;
    const patterns = bulk.pathEntries.map((e) => `/${globLiteralPath(e.path)}`);
    const gen = selectionGen.current;
    const repo = repoPath;
    try {
      const added = await appendIgnore.mutateAsync(patterns);
      toast.success(ignoreToast(added, patterns.length, ".gitignore"));
      clearSelectionIfUnchanged(gen, repo);
    } catch (e) {
      onError(e);
    }
  }

  // Bulk AI-exclude: add a `/path` line per selected file — the leading slash
  // anchors each pattern to THIS file rather than every file with that name.
  // A path holding `\` contributes a second line, so the count below is LINES,
  // which is what the toast names. The Rust side skips lines already in EFFECT.
  async function aiExcludeSelected() {
    if (bulk.pathEntries.length === 0) return;
    // Deduped: a literal `weird\name.env` and a real `weird/name.env` both emit
    // the `/`-separated line, and the duplicate would read as a false partial
    // ("Added 2 of 3") once the Rust side collapses it.
    const patterns = [
      ...new Set(
        bulk.pathEntries.flatMap((e) => aiExcludePatternLinesForPath(e.path)),
      ),
    ];
    const gen = selectionGen.current;
    const repo = repoPath;
    try {
      const added = await appendAiIgnore.mutateAsync(patterns);
      toast.success(
        ignoreToast(added, patterns.length, ".gitdesktop/aiignore"),
      );
      clearSelectionIfUnchanged(gen, repo);
    } catch (e) {
      onError(e);
    }
  }

  // Bulk untrack: `git rm --cached` the tracked files in the selection (kept on
  // disk) + add their ignore lines, in one shot.
  async function untrackSelected() {
    const tracked = bulk.trackedPathEntries;
    if (tracked.length === 0) return;
    const gen = selectionGen.current;
    const repo = repoPath;
    try {
      await untrack.mutateAsync({
        pathspecs: tracked.map((e) => literalPathspec(e.path)),
        ignorePatterns: tracked.map((e) => `/${globLiteralPath(e.path)}`),
      });
      toast.success(
        `Untracked ${tracked.length} file${tracked.length === 1 ? "" : "s"} — kept on disk, added to .gitignore`,
      );
      clearSelectionIfUnchanged(gen, repo);
    } catch (e) {
      onError(e);
    }
  }

  async function confirmDiscard() {
    if (!discardScope) return;
    if (refuseIfSwitched(discardScope.repo, "nothing was discarded")) {
      setDiscardScope(null);
      return;
    }
    // Cancel stays live while a write is pending, so a newer scope and a newer
    // selection may exist by the time this one settles: close only the scope
    // being confirmed, and clear only a selection nobody replaced since.
    const confirming = discardScope;
    const gen = selectionGen.current;
    const finish = () => {
      setDiscardScope((cur) => (cur === confirming ? null : cur));
      // A folder action leaves an unrelated selection alone, like folder Stage.
      if (confirming.kind !== "files" || confirming.folder === undefined)
        clearSelectionIfUnchanged(gen, confirming.repo);
    };
    if (discardScope.kind === "all") {
      try {
        await discardAll.mutateAsync(undefined);
        toast.success("All changes discarded");
        finish();
      } catch (e) {
        onError(e);
        finish();
      }
      return;
    }
    const targets = discardScope.entries.map((e) => ({
      path: e.path,
      untracked: e.unstaged === "untracked",
    }));
    try {
      await discardPaths.mutateAsync(targets);
      toast.success(
        targets.length === 1
          ? `Discarded changes to ${targets[0].path}`
          : `Discarded changes to ${targets.length} files`,
      );
      finish();
    } catch (e) {
      onError(e);
      finish();
    }
  }

  async function confirmStash() {
    if (!stashScope) return;
    if (refuseIfSwitched(stashScope.repo, "nothing was stashed")) {
      setStashScope(null);
      return;
    }
    // As in confirmDiscard: close only this scope, and clear only a selection
    // nobody replaced since.
    const confirming = stashScope;
    const gen = selectionGen.current;
    const finish = () => {
      setStashScope((cur) => (cur === confirming ? null : cur));
      // A folder action leaves an unrelated selection alone, like folder Stage.
      if (confirming.kind !== "files" || confirming.folder === undefined)
        clearSelectionIfUnchanged(gen, confirming.repo);
    };
    if (stashScope.kind === "all") {
      try {
        await stashAll.mutateAsync(undefined);
        // A new stash buries the recorded backup, so a refused stash leaves its
        // offer; git's "No local changes to save" also resolves and clears it.
        useStashReapplyMarker.getState().clearFor(stashScope.repo);
        toast.success("Changes stashed");
        finish();
      } catch (e) {
        onError(e);
        finish();
      }
      return;
    }
    const targets = stashScope.entries.map((e) => e.path);
    try {
      // Literal pathspecs so a `[slug]`-style path can't sweep a sibling's work
      // into the stash.
      const matched = await stashPaths.mutateAsync(
        targets.map(literalPathspec),
      );
      // `matched` is false when the paths matched nothing, so no stash exists to
      // report — the selection no longer had changes when git ran.
      if (matched) {
        useStashReapplyMarker.getState().clearFor(stashScope.repo);
        const stashed = stashScope.entries.filter((e) => !staysOutOfStash(e));
        toast.success(
          stashed.length === 1
            ? `Stashed ${stashed[0].path}`
            : `Stashed ${stashed.length} files`,
        );
      } else {
        toast.info("Nothing to stash");
      }
      finish();
    } catch (e) {
      onError(e);
      finish();
    }
  }

  useHotkeyAction(
    "stage-all",
    stageAll,
    !mutating && stageableUnstaged.length > 0,
  );
  useHotkeyAction(
    "unstage-all",
    unstageAll,
    !mutating && stagedEntries.length > 0,
  );
  useHotkeyAction(
    "stage-selected-files",
    () => void stageSelected(),
    !mutating && stageableSelected.length > 0,
  );
  useHotkeyAction(
    "unstage-selected-files",
    () => void unstageSelected(),
    !mutating && bulk.stagedRows.length > 0,
  );
  useHotkeyAction(
    "stage-folder",
    () => {
      if (folderCursor?.section === "unstaged")
        stageFolderIn(folderCursor.path, repoPath);
    },
    !mutating &&
      folderCursor?.section === "unstaged" &&
      folderCursorTargets.primary > 0,
  );
  useHotkeyAction(
    "unstage-folder",
    () => {
      if (folderCursor?.section === "staged")
        unstageFolderIn(folderCursor.path, repoPath);
    },
    !mutating &&
      folderCursor?.section === "staged" &&
      folderCursorTargets.primary > 0,
  );
  // A fire over an open or settling confirm would swap the scope under it.
  const noConfirm =
    discardScope === null &&
    stashScope === null &&
    !discardPaths.isPending &&
    !stashPaths.isPending &&
    !discardAll.isPending &&
    !stashAll.isPending;
  useHotkeyAction(
    "discard-folder",
    () => {
      if (folderCursor?.section === "unstaged")
        requestDiscardFolder(folderCursor.path, repoPath);
    },
    !mutating &&
      noConfirm &&
      folderCursor?.section === "unstaged" &&
      folderCursorTargets.discardable > 0,
  );
  useHotkeyAction(
    "stash-folder",
    () => {
      if (folderCursor !== null)
        requestStashFolder(folderCursor.section, folderCursor.path, repoPath);
    },
    !mutating &&
      noConfirm &&
      !anyConflicted &&
      folderCursor !== null &&
      folderCursorTargets.stashable > 0,
  );
  useHotkeyAction(
    "focus-filter",
    () => filterRef.current?.focus(),
    entries.length > 0,
  );
  useHotkeyAction(
    "toggle-changes-tree",
    toggleViewMode,
    entries.length > 0 && settings.data !== undefined,
  );
  // Resolve the selected conflicted file with AI, or start an all-conflicts run
  // when the selection isn't a conflict. Palette-only (no default binding).
  // The enable keys on the polled status, which lags a resolve made outside the
  // app, so the activation re-reads status once before it starts anything. A
  // second fire while that read is out is dropped: it would start a second run.
  const resolveCheckInFlight = useRef(false);
  async function resolveConflictsWithAi() {
    if (resolveCheckInFlight.current) return;
    const firedOn = repoPath;
    const target = selectedFile;
    const cached = conflictedPaths;
    const firedAt = Date.now();
    // The press is the request, so it bumps here, once: the start after the
    // re-read lands on this claim without bumping again, and any interaction
    // during the read retires it.
    useUiStore.getState().noteUserInteraction();
    const claimedEpoch = useUiStore.getState().interactionEpoch;
    resolveCheckInFlight.current = true;
    const result = await status.refetch();
    resolveCheckInFlight.current = false;
    if (
      refuseIfSwitched(
        firedOn,
        "the AI resolve didn't start",
        "while re-checking for conflicts",
      )
    )
      return;
    if (useUiStore.getState().interactionEpoch !== claimedEpoch) return;
    // Fail toward unknown: a failed re-read never says "no conflicts", so it
    // proceeds on the last successful read. A refetch another fetch cancelled
    // resolves with the observer's PRE-refetch result, still a success, so only
    // data stamped at or after the fire counts as the re-read.
    const fresh =
      result.isSuccess && result.data && result.dataUpdatedAt >= firedAt
        ? result.data.entries.filter(isConflictedEntry).map((e) => e.path)
        : cached;
    if (fresh.length === 0) {
      // The store's startAll would no-op silently on an empty set.
      toast.info("No conflicted files left to resolve.");
      return;
    }
    if (target && fresh.includes(target.path))
      startResolveOne(target.path, firedOn, { claimedEpoch });
    else startResolveAll(fresh, firedOn, { claimedEpoch });
  }
  useHotkeyAction(
    "resolve-conflict-ai",
    () => void resolveConflictsWithAi(),
    canResolveConflicts,
  );

  // First in every arm so the region stays mounted across them: it announces
  // only text that arrives after it is in the DOM. The content beside it is
  // keyed per arm, so the list still mounts (and fades in) fresh. Outside the
  // skeleton's aria-busy subtree, for the same reason as the shared skeleton
  // component; it may announce for a load that resolves inside the skeleton's
  // 150ms visual delay (a polite region, accepted).
  let statusAnnouncement: string | null = null;
  if (readFailed) statusAnnouncement = STATUS_READ_FAILED_REASON;
  else if (status.isPending) statusAnnouncement = "Loading changes…";
  // Lowest priority: what the last advance did, written only by the transition
  // effect. The seq's zero-width space makes a repeated message re-announce.
  else if (advanceNote.text && advanceNote.read === status.data)
    statusAnnouncement = advanceNote.text + ZWSP.repeat(advanceNote.seq % 2);
  const statusLiveRegion = (
    <span role="status" className="sr-only">
      {statusAnnouncement}
    </span>
  );

  // Ahead of the skeleton: each poll of a never-loaded failed read flips it back
  // to pending, so this order is what holds the block steady.
  if (readFailed) {
    return (
      <>
        {statusLiveRegion}
        <StatusReadErrorState
          error={status.error ?? status.failureReason ?? retainedStatusError}
          onRetry={() => void status.refetch()}
          repoPath={repoPath}
          rescueRef={errorBlockRef}
        />
      </>
    );
  }

  if (status.isPending) {
    return (
      // Geometry copied from the empty state (Empty gap-4 p-6; EmptyMedia
      // size-8 mb-2; header gap-2) so a clean tree resolves its icon/title
      // onto these bars. The 150ms animation delay keeps a fast status
      // resolve from ever painting a placeholder. A dirty tree resolves
      // top-anchored instead; the placeholder bets on the clean-tree outcome
      // (owner call), so that swap is a content change, not an anchor miss.
      // A delayed paint isn't motion, so the 0-duration animation runs
      // unconditionally; the fade is the motion-safe layer on top.
      <>
        {statusLiveRegion}
        <div
          key="skeleton"
          aria-busy
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 animate-in fade-in-0 delay-150 duration-0 fill-mode-backwards motion-safe:duration-200"
        >
          {/* pb-28 reserves the action stack the swap actually paints: the
              compare query stays disabled until status resolves and the forge
              probe hasn't answered yet, so the PR / View-on-GitHub buttons
              cannot be present (3 h-7 buttons + gaps). They pop in as those
              queries land — that later shift is the empty state's own,
              independent of this placeholder. */}
          <div className="flex flex-col items-center gap-2 pb-28">
            <Skeleton className="mb-2 size-8" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-36" />
          </div>
        </div>
      </>
    );
  }

  // Confirm-dialog copy, derived from each action's scope (a single file, a
  // multi-selection, or the whole tree).
  const { title: discardTitle, body: discardBody } = discardConfirmCopy(
    shownDiscardScope,
    entries,
  );
  const { title: stashTitle, body: stashBody } =
    stashConfirmCopy(shownStashScope);

  // One row's inner content, closing over the panel's selection/mutation state.
  // Passed to the virtualized list so all that state stays here and only the
  // virtualizer instance lives in the keyed leaf.
  const renderRow = (row: FlatRow): ReactNode => {
    if (row.type === "header")
      return (
        <div
          data-section-header={row.section}
          className={cn(
            "flex items-center justify-between pr-1 pl-2",
            // Gap only between the staged and unstaged sections, never at the
            // very top of the list.
            row.section === "unstaged" && stagedEntries.length > 0 && "pt-2",
          )}
        >
          <h3 className="py-1 text-xs font-medium text-muted-foreground">
            {/* A non-option inside the listbox, with no aria-controls: every row
              is a flat virtualized sibling (no group to own) and a collapsed
              section's rows unmount. aria-expanded carries the state. */}
            <button
              type="button"
              data-section-toggle={row.section}
              aria-expanded={!collapsedSections.has(row.section)}
              className="flex cursor-pointer items-center gap-1 hover:text-foreground"
              onClick={() => toggleSection(row.section)}
            >
              {collapsedSections.has(row.section) ? (
                <CaretRightIcon className="size-3 shrink-0" />
              ) : (
                <CaretDownIcon className="size-3 shrink-0" />
              )}
              {row.section === "staged"
                ? `Staged (${row.count})`
                : `Changes (${row.count})`}
            </button>
          </h3>
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={
              mutating ||
              (row.section === "unstaged" && stageableUnstaged.length === 0)
            }
            reason={
              row.section === "unstaged" && stageableUnstaged.length === 0
                ? "Git can't stage Windows-reserved device names, and every file here has one"
                : null
            }
            onClick={row.section === "staged" ? unstageAll : stageAll}
          >
            {row.section === "staged" ? "Unstage all" : "Stage all"}
          </DisabledReasonButton>
        </div>
      );
    if (row.type === "folder")
      return (
        // The caret, the indent, and the count carry the structure — never the
        // colour alone. No collapse animation: the rows are virtualized, so the
        // caret swap is the state feedback.
        <div
          data-row={rowKeyOf(row)}
          role="option"
          aria-selected={false}
          // ARIA 1.2 gives `option` no expanded state, so the label carries
          // what the caret shows — and the full directory path, because two
          // compacted rows can share a display label.
          aria-label={`${row.path} — ${row.count} ${
            row.count === 1 ? "file" : "files"
          }, ${row.collapsed ? "collapsed" : "expanded"}`}
          tabIndex={rowKeyOf(row) === tabStopKey ? 0 : -1}
          className="flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs text-muted-foreground hover:bg-muted/60"
          style={{ paddingLeft: 8 + row.depth * 12 }}
          onClick={() => handleFolderActivate(row)}
          onKeyDown={(e) => {
            // Chords pass to the window listener (the commit shortcut).
            if (e.target !== e.currentTarget || hasChordModifier(e)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleFolderActivate(row);
            }
          }}
        >
          {row.collapsed ? (
            <CaretRightIcon className="size-3 shrink-0" />
          ) : (
            <CaretDownIcon className="size-3 shrink-0" />
          )}
          <PathText
            path={row.label}
            title={row.path}
            className="min-w-0 flex-1"
          />
          <span className="shrink-0 tabular-nums">({row.count})</span>
        </div>
      );
    return (
      <FileRow
        entry={row.entry}
        kind={
          (row.staged ? row.entry.staged : row.entry.unstaged) ?? "modified"
        }
        staged={row.staged}
        disabled={mutating}
        checking={checking}
        stat={statFor(row.entry, row.staged)}
        selected={selectedKeys.has(keyOf(row.entry.path, row.staged))}
        active={
          selectedFile?.path === row.entry.path &&
          selectedFile.staged === row.staged
        }
        tabStop={keyOf(row.entry.path, row.staged) === tabStopKey}
        treeDisplay={treeMode}
        indentPx={treeMode ? (row.depth ?? 0) * 12 : undefined}
        onSelect={handleSelect}
        onToggle={handleToggle}
      />
    );
  };

  // Calm fade as data replaces the loading skeleton (runs once on mount; a
  // one-shot opacity fade is the existing tw-animate-css idiom, lighter than
  // wrapping this whole tree in a motion component). Reduced-motion-safe.
  return (
    <>
      {statusLiveRegion}
      <div
        key="changes"
        className="flex min-h-0 flex-1 flex-col motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
      >
        <ConflictBanner
          repoPath={repoPath}
          conflictedPaths={conflictedPaths}
          statusUpdatedAt={status.dataUpdatedAt}
          landingRef={landingRef}
        />
        {/* Above the empty state too: a clean tree's refresh failure would
          otherwise hide behind a possibly stale "No local changes". */}
        <StatusRefreshFailedStrip
          degraded={statusRefreshFailed}
          onRetry={() => void status.refetch()}
          onDetails={() => openStatusErrorDetails(status.error)}
        />
        <span ref={markerLandingEl} tabIndex={-1} className="outline-none" />

        {entries.length === 0 ? (
          <ChangesEmptyState
            repoPath={repoPath}
            isUnborn={isUnborn}
            ghReady={ghReady}
            proposeCount={proposeCount}
            currentName={currentName}
            defaultName={defaultName}
          />
        ) : (
          <>
            <div className="flex items-center gap-1 border-b p-2">
              <Popover.Root>
                <Popover.Trigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={
                        activeKinds.size > 0
                          ? `Filter options (${activeKinds.size} active)`
                          : "Filter options"
                      }
                      className="relative"
                    />
                  }
                >
                  <FunnelIcon />
                  {activeKinds.size > 0 && (
                    <span
                      aria-hidden
                      className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center bg-primary text-[9px] font-medium text-primary-foreground tabular-nums"
                    >
                      {activeKinds.size}
                    </span>
                  )}
                </Popover.Trigger>
                <Popover.Portal container={portalContainer}>
                  <Popover.Positioner
                    align="start"
                    sideOffset={4}
                    className="isolate z-50"
                  >
                    <Popover.Popup className="w-56 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                      <p className="px-1 pb-1.5 text-xs font-medium">
                        Filter Options
                      </p>
                      {(Object.keys(FILTER_LABELS) as FilterKind[]).map(
                        (kind) => (
                          <label
                            key={kind}
                            className="flex cursor-pointer items-center gap-2 rounded-none px-1 py-1.5 text-xs hover:bg-muted/60"
                          >
                            <Checkbox
                              checked={activeKinds.has(kind)}
                              onCheckedChange={(v) =>
                                toggleKind(kind, v === true)
                              }
                            />
                            <span className="flex-1">
                              {FILTER_LABELS[kind]}
                            </span>
                            <span className="text-muted-foreground">
                              ({entries.filter(FILTER_PREDICATES[kind]).length})
                            </span>
                          </label>
                        ),
                      )}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              <Input
                ref={filterRef}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter"
                className="h-7 flex-1"
                autoComplete="off"
              />
              <Button
                ref={viewToggleRef}
                variant={treeMode ? "secondary" : "outline"}
                size="icon-sm"
                aria-pressed={treeMode}
                aria-label="Directory tree view"
                title={
                  treeMode
                    ? "Show changes as a flat list"
                    : "Group changes by directory"
                }
                onClick={toggleViewMode}
              >
                <TreeViewIcon />
              </Button>
            </div>

            {/* Gate on settings.data being loaded so "Don't show again" (which
              merges into it) can't silently no-op during the brief cold load. */}
            {settings.data &&
              (settings.data.showSelectionHint ?? true) &&
              entries.length >= 2 && (
                <InfoNote
                  className="px-2.5"
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        if (!settings.data) return;
                        void saveSettings
                          .mutateAsync({
                            ...settings.data,
                            showSelectionHint: false,
                          })
                          .catch(() => undefined);
                      }}
                      className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2 hover:no-underline"
                    >
                      Don't show again
                    </button>
                  }
                >
                  {formatBinding("mod")}-click to select files individually,
                  Shift-click for a range.
                </InfoNote>
              )}

            <ContextMenu>
              {/* Keyed on repoPath so a repo switch mints a fresh virtualizer at
                offset 0, exactly like a fresh open. A persisted instance carries
                its offset across element swaps: virtual-core writes scrollOffset
                from the scroll listener, never on re-observe, and derives the
                range from it unclamped. An uncached switch already remounts this
                via the empty-state transit; the key covers the cached one. */}
              <VirtualizedChangeList
                key={repoPath}
                flatRows={flatRows}
                hasStaged={stagedEntries.length > 0}
                entries={status.data?.entries}
                text={text}
                activeKinds={activeKinds}
                viewMode={viewMode}
                collapsedFolders={collapsedFolders}
                collapsedSections={collapsedSections}
                activeRowKey={cursorKey}
                focusCursorMove={focusCursorMove}
                tabStopKey={tabStopKey}
                nothingMatches={nothingMatches}
                onClearFilter={() => {
                  setFilterText("");
                  setActiveKinds(new Set());
                }}
                onListKeyDown={handleListKeyDown}
                onListFocus={handleRowFocus}
                onListFocusIn={trackListFocusIn}
                onListFocusOut={trackListFocusOut}
                onListEl={handleListEl}
                onContextMenuCapture={handleContextMenu}
                focusTargetKey={focusTargetKey}
                onCursorScrolled={claimPendingFocus}
                onFocusTargetLost={dropFocusTarget}
                renderRow={renderRow}
              />
              <ContextMenuContent className="min-w-64">
                <ChangesContextMenuItems
                  target={menuTarget}
                  repoPath={repoPath}
                  inSelection={
                    menuTarget?.kind === "row"
                      ? selectedKeys.has(
                          keyOf(menuTarget.entry.path, menuTarget.staged),
                        )
                      : false
                  }
                  rowCount={bulk.rowCount}
                  stagedRowCount={bulk.stagedRows.length}
                  unstagedRowCount={bulk.unstagedRows.length}
                  stageableCount={stageableSelected.length}
                  pathCount={bulk.pathEntries.length}
                  stashablePathCount={stashablePathCount}
                  trackedPathCount={bulk.trackedPathEntries.length}
                  discardableCount={selectedDiscard.targets.length}
                  anyConflicted={anyConflicted}
                  folderCounts={folderCounts}
                  actions={{
                    stageFolder: () => {
                      if (menuTarget?.kind === "folder")
                        stageFolderIn(menuTarget.path, menuTarget.repo);
                    },
                    unstageFolder: () => {
                      if (menuTarget?.kind === "folder")
                        unstageFolderIn(menuTarget.path, menuTarget.repo);
                    },
                    discardFolder: () => {
                      if (
                        menuTarget?.kind === "folder" &&
                        menuTarget.section === "unstaged"
                      )
                        requestDiscardFolder(menuTarget.path, menuTarget.repo);
                    },
                    stashFolder: () => {
                      if (menuTarget?.kind === "folder")
                        requestStashFolder(
                          menuTarget.section,
                          menuTarget.path,
                          menuTarget.repo,
                        );
                    },
                    discardAll: () =>
                      setDiscardScope({ kind: "all", repo: repoPath }),
                    stashAll: () =>
                      setStashScope({ kind: "all", repo: repoPath }),
                    stageSelected: () => void stageSelected(),
                    unstageSelected: () => void unstageSelected(),
                    discardSelected: requestDiscardSelected,
                    stashSelected: requestStashSelected,
                    ignoreSelected: () => void ignoreSelected(),
                    untrackSelected: () => void untrackSelected(),
                    toggle: handleToggle,
                    resolveWithAi: (path) => startResolveOne(path, repoPath),
                    discardFile: (entry) =>
                      setDiscardScope({
                        kind: "files",
                        entries: [entry],
                        repo: repoPath,
                      }),
                    stashFile: (entry, staged) =>
                      setStashScope({
                        kind: "files",
                        entries: [entry],
                        repo: repoPath,
                        split:
                          bulkRowTargets(
                            new Set([keyOf(entry.path, staged)]),
                            entries,
                          ).splitPaths.length > 0,
                      }),
                    viewHistory: setHistoryPath,
                    blame: setBlamePath,
                    ignore: (pattern, label) => void ignoreOne(pattern, label),
                    untrack: (pathspec, ignorePattern, label) =>
                      void untrackOne(pathspec, ignorePattern, label),
                    aiExclude: (patterns, label) =>
                      void aiExcludeOne(patterns, label),
                    aiExcludeSelected: () => void aiExcludeSelected(),
                  }}
                />
              </ContextMenuContent>
            </ContextMenu>
          </>
        )}

        {(stashCount.data ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setStashesOpen(true)}
            className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-left text-xs hover:bg-muted/60"
            title="View stashed changes on this branch"
          >
            <StackIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 font-medium">Stashed Changes</span>
            <span className="text-muted-foreground tabular-nums">
              {stashCount.data}
            </span>
            <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}

        <StashesDialog
          repoPath={repoPath}
          open={stashesOpen}
          onOpenChange={setStashesOpen}
        />

        {historyPath && (
          <FileHistoryDialog
            repoPath={repoPath}
            path={historyPath}
            open
            onOpenChange={(o) => {
              if (!o) setHistoryPath(null);
            }}
          />
        )}
        {blamePath && (
          <BlameDialog
            repoPath={repoPath}
            path={blamePath}
            open
            onOpenChange={(o) => {
              if (!o) setBlamePath(null);
            }}
          />
        )}

        <ConfirmDialog
          open={discardScope !== null}
          onCancel={() => setDiscardScope(null)}
          title={discardTitle}
          body={discardBody}
          confirmLabel={
            shownDiscardScope?.kind === "all" ? "Discard all" : "Discard"
          }
          confirmVariant="destructive"
          pending={discardPaths.isPending || discardAll.isPending}
          onConfirm={() => void confirmDiscard()}
        />

        <ConfirmDialog
          open={stashScope !== null}
          onCancel={() => setStashScope(null)}
          title={stashTitle}
          body={stashBody}
          confirmLabel={shownStashScope?.kind === "all" ? "Stash all" : "Stash"}
          pending={stashPaths.isPending || stashAll.isPending}
          onConfirm={() => void confirmStash()}
        />
      </div>
    </>
  );
}

/** The virtualized changes list, isolated so ChangesPanel can key it on
 *  `repoPath`: only a fresh instance starts at scroll offset 0. virtual-core
 *  writes `scrollOffset` from the scroll listener, never when it re-observes a
 *  new element, so a persisted instance carries a deep offset onto a brand-new
 *  scroll div and derives its range from that unclamped, dropping index 0 (the
 *  Staged header). Owning `useVirtualizer` here also confines the React Compiler
 *  bailout it triggers to this leaf (the HistoryPanel/CommitList split). */
function VirtualizedChangeList({
  flatRows,
  hasStaged,
  entries,
  text,
  activeKinds,
  viewMode,
  collapsedFolders,
  collapsedSections,
  activeRowKey,
  focusCursorMove,
  tabStopKey,
  nothingMatches,
  onClearFilter,
  onListKeyDown,
  onListFocus,
  onListFocusIn,
  onListFocusOut,
  onListEl,
  onContextMenuCapture,
  focusTargetKey,
  onCursorScrolled,
  onFocusTargetLost,
  renderRow,
}: {
  flatRows: FlatRow[];
  hasStaged: boolean;
  /** `status.data?.entries` — a `getItemKey` identity input, not read directly. */
  entries: FileEntry[] | undefined;
  text: string;
  activeKinds: Set<FilterKind>;
  /** A `getItemKey` identity input, not read directly. */
  viewMode: (typeof CHANGES_VIEW_MODES)[number];
  /** A `getItemKey` identity input, not read directly. */
  collapsedFolders: Set<string>;
  /** A `getItemKey` identity input; a change also skips one cursor scroll. */
  collapsedSections: Set<ChangesSection>;
  /** The cursor row — a file or (tree mode) a folder — kept scrolled into view. */
  activeRowKey: string | null;
  /** Re-minted with a cursor change that focus caused; that change skips the
   *  cursor scroll, since the focused row is already mounted and in view. */
  focusCursorMove: object;
  /** The list's roving tab stop, kept mounted at any scroll position. */
  tabStopKey: string | null;
  nothingMatches: boolean;
  onClearFilter: () => void;
  onListKeyDown: (e: KeyboardEvent) => void;
  /** Every focus inside the list, delegated: the panel keeps its folder cursor
   *  in step with the row focus landed in. */
  onListFocus: (e: FocusEvent) => void;
  /** Capture-phase focusin/focusout over the list (headers included): the
   *  panel tracks whether the list owned focus last. */
  onListFocusIn: (e: FocusEvent) => void;
  onListFocusOut: (e: FocusEvent) => void;
  /** Hands the mounted scroll container up to the panel, which queries rows
   *  through it. Must be referentially stable — it rides the element's ref. */
  onListEl: (el: HTMLDivElement | null) => void;
  onContextMenuCapture: (e: MouseEvent) => void;
  /** A pending focus claim's row that is NOT the cursor, scrolled to like the
   *  cursor row; null once the claim settles. */
  focusTargetKey: string | null;
  /** Called a frame after the cursor row (or the focus target) is scrolled to,
   *  so the panel can focus a row it could not reach while unmounted. False =
   *  still unmounted, retry. */
  onCursorScrolled: () => boolean;
  /** The focus target's claim never settled within its tries. */
  onFocusTargetLost: (key: string) => void;
  renderRow: (row: FlatRow) => ReactNode;
}) {
  // State-backed (not a plain ref) so the virtualizer observes the scroll
  // element the instant it mounts — a plain ref would leave the first paint blank.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Both sinks for that one element: the state write the virtualizer's mount
  // contract needs, and the panel's handle for its focus restores. Stable, or
  // React would detach and re-attach the node on every render.
  const setListEl = useCallback(
    (el: HTMLDivElement | null) => {
      setScrollEl(el);
      onListEl(el);
    },
    [onListEl],
  );
  // The virtualizer keys its measurement projection on `getItemKey`'s IDENTITY,
  // so this is re-minted per row sequence rather than per render: a fresh closure
  // every render rebuilds all rows (1.7ms vs 0.019ms at 20k rows, measured on
  // virtual-core 3.17.8), while never re-minting leaves a pure permutation —
  // stage one file, count unchanged — painting each header into the previous
  // occupant's slot. These deps are the sequence's only inputs: the entries, the
  // filter, (tree mode) the layout and which directories are collapsed, and
  // which sections are collapsed.
  const flatRowsRef = useRef(flatRows);
  flatRowsRef.current = flatRows;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps re-mint the identity; the ref supplies the rows
  const getItemKey = useCallback(
    (index: number) => {
      const row = flatRowsRef.current[index];
      return row ? rowKeyOf(row) : index;
    },
    [entries, text, activeKinds, viewMode, collapsedFolders, collapsedSections],
  );
  // The rows' roving tab stop stays MOUNTED: scrolled past the overscan window
  // it would unmount, leaving every mounted row at tabIndex -1, and Tab would
  // skip every row. Mounted at its offset, Tab still enters at that row.
  const tabStopIndex = tabStopKey
    ? flatRows.findIndex((r) => rowKeyOf(r) === tabStopKey)
    : -1;
  const count = flatRows.length;
  const rangeExtractor = useCallback(
    (range: Range) =>
      mergePinnedIndexes(defaultRangeExtractor(range), [tabStopIndex], count),
    [tabStopIndex, count],
  );
  const rowVirtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => {
      const r = flatRows[i];
      if (r.type === "file") return 28;
      if (r.type === "folder") return 24;
      // The "Changes" header carries a top gap only when it follows the staged
      // section; bake that into the estimate so the first paint never overlaps.
      return r.section === "unstaged" && hasStaged ? 40 : 32;
    },
    // Key by row identity, not index: staging and working-tree churn shift rows
    // between indexes, and an index key hands a section header the height
    // measured for whatever row sat there before, so the next row overlaps it.
    getItemKey,
    rangeExtractor,
    overscan: 16,
  });
  // Flat index of the cursor row, so we can keep it scrolled into view under
  // virtualization (its own DOM node may not be mounted). Folder rows count: in
  // tree mode the cursor can rest on one.
  const activeFlatIndex = activeRowKey
    ? flatRows.findIndex((r) => rowKeyOf(r) === activeRowKey)
    : -1;
  // Keep the active row scrolled into view as the selection moves — under
  // virtualization its DOM node may not be mounted, so scroll by index. The row
  // mounts on the virtualizer's own re-render, a frame or more after the scroll,
  // so the deferred focus claim gets a few frames before it gives up. Keyed on
  // the row IDENTITY too: an expand can re-key the cursor row at the SAME flat
  // index, and the pending-focus claim must still run — and on the view MODE,
  // which is what a flip-armed claim waits for: the cursor's row can sit at the
  // same index in both layouts (a root-level file above the section that held
  // the folders), and that claim would then never be re-offered.
  const sectionsSeen = useRef(collapsedSections);
  const focusMoveSeen = useRef(focusCursorMove);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active change
  useEffect(() => {
    if (activeFlatIndex < 0) return;
    // A section toggle shifts the cursor's index (or reveals its row) without
    // moving the cursor; scrolling there would carry the clicked toggle out of
    // the window and drop focus to <body>. A cursor move that focus caused
    // skips too: the scroll would carry the pressed row out from under the
    // pointer, so the click lands elsewhere.
    if (
      sectionsSeen.current === collapsedSections &&
      focusMoveSeen.current === focusCursorMove
    )
      rowVirtualizer.scrollToIndex(activeFlatIndex, { align: "auto" });
    let frame = 0;
    let tries = 3;
    const claim = () => {
      tries -= 1;
      if (onCursorScrolled() || tries === 0) return;
      frame = requestAnimationFrame(claim);
    };
    frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [activeFlatIndex, activeRowKey, viewMode]);
  // Every commit, after the effect above compared against the previous one, so
  // a toggle's (or a focus move's) skip lasts its own commit even when that
  // effect never ran.
  useEffect(() => {
    sectionsSeen.current = collapsedSections;
  });
  useEffect(() => {
    focusMoveSeen.current = focusCursorMove;
  });
  const focusTargetIndex = focusTargetKey
    ? flatRows.findIndex((r) => rowKeyOf(r) === focusTargetKey)
    : -1;
  // Returns the effect's cleanup. A claim still unsettled after its tries gives
  // up outright, so it can't re-scroll the list on some later pass.
  const revealFocusTarget = useEffectEvent((index: number, key: string) => {
    const giveUp = onFocusTargetLost;
    // A row no longer listed can never mount: give up now.
    if (index < 0) {
      giveUp(key);
      return;
    }
    rowVirtualizer.scrollToIndex(index, { align: "auto" });
    const claimNow = onCursorScrolled;
    let frame = 0;
    let tries = 3;
    const claim = () => {
      tries -= 1;
      if (claimNow()) return;
      if (tries === 0) {
        giveUp(key);
        return;
      }
      frame = requestAnimationFrame(claim);
    };
    frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  });
  // The same reveal for a non-cursor focus claim. Its own effect, declared after
  // the cursor's so it wins a shared pass: folded into the cursor effect, the
  // claim settling would re-key that effect and scroll back to the cursor.
  useEffect(() => {
    if (focusTargetKey === null) return;
    return revealFocusTarget(focusTargetIndex, focusTargetKey);
  }, [focusTargetIndex, focusTargetKey]);
  // Jump back to the top whenever the filter changes the visible set. Gated on
  // the filter actually changing: <Activity> replays effects on every tab show,
  // and an unguarded reset would drop the scroll position it preserves.
  const prevFilter = useRef({ text, activeKinds });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => {
    const prev = prevFilter.current;
    if (prev.text === text && prev.activeKinds === activeKinds) return;
    prevFilter.current = { text, activeKinds };
    rowVirtualizer.scrollToOffset(0);
  }, [text, activeKinds]);

  return (
    <ContextMenuTrigger
      render={
        // The whole list is one right-click target + one virtualizer, so
        // thousands of changed files no longer mount thousands of menus/rows.
        // `onContextMenuCapture` (capture phase, so it runs before the menu
        // opens) records which row/header was hit.
        <div
          ref={setListEl}
          className="min-h-0 flex-1 overflow-y-auto"
          onKeyDown={onListKeyDown}
          onFocus={onListFocus}
          onFocusCapture={onListFocusIn}
          onBlurCapture={onListFocusOut}
          onContextMenuCapture={onContextMenuCapture}
          role="listbox"
          aria-label="Changed files"
          aria-multiselectable="true"
        />
      }
    >
      {nothingMatches ? (
        <div className="px-2 py-8 text-center text-xs text-muted-foreground">
          <p>No files match the filter</p>
          <button
            type="button"
            onClick={onClearFilter}
            className="mt-1 cursor-pointer font-medium underline underline-offset-2 hover:no-underline"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <div
          className="relative w-full"
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = flatRows[vi.index];
            return (
              <div
                key={rowKeyOf(row)}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      )}
    </ContextMenuTrigger>
  );
}
