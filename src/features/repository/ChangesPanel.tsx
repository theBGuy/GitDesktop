import { Popover } from "@base-ui/react/popover";
import {
  CaretDownIcon,
  CaretRightIcon,
  FunnelIcon,
  InfoIcon,
  StackIcon,
  TreeViewIcon,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { BlameDialog } from "@/features/history/BlameDialog";
import { FileHistoryDialog } from "@/features/history/FileHistoryDialog";
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
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { flattenPathTree } from "@/lib/path-tree";
import { CHANGES_VIEW_MODES } from "@/lib/settings/api";
import {
  useAiEnabled,
  useReviewConfigured,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useUiStore } from "@/lib/stores/ui";
import { ignoreToast, toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { ChangesContextMenuItems, type MenuTarget } from "./ChangesContextMenu";
import { ChangesEmptyState } from "./ChangesEmptyState";
import { ConflictBanner } from "./ConflictBanner";
import { FileRow } from "./FileRow";
import { StashesDialog } from "./StashesDialog";

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

/** The discard-copy predicate: recycle-bin refusal keys on the reserved NAME,
 *  not on stageability — kept a sibling of `canStage` so the two rules can
 *  diverge without silently changing the confirm copy. */
function isReservedName(entry: FileEntry): boolean {
  return reservedDeviceName(entry.path) !== null;
}

/** Appended to a multi-file discard confirm: the recycle bin refuses a reserved
 *  device name, so the backend removes those outright. */
const RESERVED_DISCARD_NOTE =
  ' Files with Windows-reserved names (like "nul") skip the recycle bin and are deleted permanently.';

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

/** Target of a discard/stash confirm dialog: specific files (one row or a
 *  multi-selection) or the whole working tree. Null = no dialog open. */
type ChangeActionScope =
  | { kind: "files"; entries: FileEntry[] }
  | { kind: "all" }
  | null;

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

/** Splits a folder row key back into its section and directory path. */
const FOLDER_ROW_KEY_RE = /^folder:(staged|unstaged):(.+)$/;

/** The indent level a row sits at; headers and list-mode files are at the root. */
function rowDepth(row: FlatRow): number {
  if (row.type === "header") return 0;
  if (row.type === "folder") return row.depth;
  return row.depth ?? 0;
}

export function ChangesPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  /** The Changes tab is the visible one. A `<TabPanel>`-hidden panel still
   *  renders, so the line-count poll is gated on this rather than on mounting. */
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
  // Tree mode's collapsed directories, keyed `"<section>:<dirPath>"`. Session-local
  // by design: the changes list is ephemeral, so a collapse outlives neither a
  // repo switch nor a restart.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  // The nav cursor when it rests on a folder row (which has no diff to show, so
  // `selectedFile` stays where it was). Null = the cursor follows `selectedFile`.
  const [activeFolderKey, setActiveFolderKey] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [activeKinds, setActiveKinds] = useState<Set<FilterKind>>(new Set());
  const [stashesOpen, setStashesOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  // The one shared context menu acts on whatever was right-clicked.
  const [menuTarget, setMenuTarget] = useState<MenuTarget>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const viewToggleRef = useRef<HTMLButtonElement>(null);
  // A cursor row a horizontal jump could not focus because the virtualizer had
  // not mounted it yet; claimed once the scroll brings it in.
  const pendingFocusKey = useRef<string | null>(null);
  // The view mode a flip-armed claim waits for; null = claimable right away.
  const pendingFocusMode = useRef<"list" | "tree" | null>(null);
  // The row focus sat in when that claim was armed; null = focus was not on a
  // row (a background arm, with the caret in the filter or outside the list).
  const pendingFocusSource = useRef<string | null>(null);

  const entries = status.data?.entries ?? [];
  const conflictedPaths = entries
    .filter((e) => e.unstaged === "conflicted" || e.staged === "conflicted")
    .map((e) => e.path);
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
  // numstat can't see untracked paths, and emits duplicate noise rows for
  // conflicted ones, so both render a blank slot.
  function statFor(entry: FileEntry, staged: boolean) {
    const kind = staged ? entry.staged : entry.unstaged;
    if (kind === "untracked" || kind === "conflicted") return undefined;
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
  // Entries behind the multi-selection (deduped to one per path), driving the
  // bulk context menu and its confirm dialogs.
  const selectedPaths = new Set(
    [...selectedKeys].map((k) => k.slice(k.indexOf(":") + 1)),
  );
  const selectedEntries = entries.filter((e) => selectedPaths.has(e.path));
  const selectionCount = selectedEntries.length;
  const stageableSelected = selectedEntries.filter(canStage);
  // Untracking only applies to files git already tracks (not fresh untracked
  // files or brand-new staged adds) — mirrors FileRow's per-file rule.
  const selectedTracked = selectedEntries.filter(
    (e) => e.unstaged !== "untracked" && e.staged !== "added",
  );

  /** A section's collapsed directories, its `"<section>:"` prefix stripped. */
  function collapsedIn(section: "staged" | "unstaged"): Set<string> {
    const prefix = `${section}:`;
    return new Set(
      [...collapsedFolders]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length)),
    );
  }

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
    if (!treeMode) {
      for (const entry of sectionEntries)
        flatRows.push({ type: "file", entry, staged });
      return;
    }
    const collapsed = collapsedIn(section);
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
  // The cursor may rest on a folder, which owns no diff; file rows keep pointing
  // at `selectedFile`, so selection behaviour is unchanged.
  const cursorKey = activeFolderKey ?? activeKey;
  const navIndex = cursorKey
    ? navRows.findIndex((r) => rowKeyOf(r) === cursorKey)
    : -1;

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
    setSelectedKeys(new Set([key]));
    setAnchorKey(key);
  }

  /** Focus + reveal a row the horizontal keys moved the cursor to (the vertical
   *  keys get this from `listKeyboardNav` itself). A jump past the virtualizer's
   *  overscan window finds no node, so it defers instead: unfocused, the row the
   *  user came from unmounts and every arrow key goes dead. */
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
   *  the claim until that view mode is on screen (see {@link claimPendingFocus}). */
  function deferFocusRow(key: string, untilMode?: "list" | "tree") {
    pendingFocusKey.current = key;
    pendingFocusMode.current = untilMode ?? null;
    // Where the gesture started, so the claim can tell focus that never moved
    // from focus that belongs to somebody else. Null for the arms that fire
    // while the caret is outside the list — they stay orphan-only.
    const from = focusedNavRow();
    pendingFocusSource.current = from ? rowKeyOf(from.row) : null;
  }

  /** A claim and its source row retire together — nothing reads one without the
   *  other. */
  function clearPendingFocus() {
    pendingFocusKey.current = null;
    pendingFocusSource.current = null;
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
    // A newer cursor move owns focus now, so this claim is stale.
    if (key !== cursorKey) {
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
  // a plain arrow collapses to the single active row.
  const navKeyDown = listKeyboardNav({
    items: navRows,
    activeIndex: navIndex,
    rowKey: rowKeyOf,
    onActivate: activateRow,
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

  // Drop the selection when the selected file leaves its section
  // (e.g. it was staged, committed, or reverted externally).
  useEffect(() => {
    if (!selectedFile || !status.data) return;
    const stillThere = status.data.entries.some(
      (e) =>
        e.path === selectedFile.path &&
        (selectedFile.staged ? e.staged !== null : e.unstaged !== null),
    );
    if (!stillThere) selectFile(null);
  }, [status.data, selectedFile, selectFile]);
  // Prune multi-selection keys for files that have left the working tree
  // (committed, discarded, etc.) so counts and highlights stay accurate.
  useEffect(() => {
    if (!status.data) return;
    const paths = new Set(status.data.entries.map((e) => e.path));
    setSelectedKeys((prev) => {
      const next = new Set(
        [...prev].filter((k) => paths.has(k.slice(k.indexOf(":") + 1))),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [status.data]);
  // Collapse state and the folder cursor name directories of the repo they were
  // made in. Guarded on the path actually changing: <Activity> replays effects
  // on every tab show, and an unguarded reset would drop the user's collapses.
  const prevRepo = useRef(repoPath);
  useEffect(() => {
    if (prevRepo.current === repoPath) return;
    prevRepo.current = repoPath;
    setCollapsedFolders(new Set());
    setActiveFolderKey(null);
  }, [repoPath]);
  // The backstop for a folder cursor whose row was re-keyed: whenever
  // `activeFolderKey` stops resolving, it is re-keyed to the surviving row or
  // cleared. Every re-key source lands here — external status churn changing
  // compaction, the toggles, any path added later; the toggle-site
  // reconciliations remain the synchronous fast path, which usually prevents the
  // orphan window entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cursor key stopped resolving
  useEffect(() => {
    if (activeFolderKey === null || navIndex !== -1) return;
    const parsed = FOLDER_ROW_KEY_RE.exec(activeFolderKey);
    if (!parsed) return;
    const section = parsed[1] as "staged" | "unstaged";
    const dir = parsed[2];
    // A re-key only ever extends the chain downward (a shortened chain keeps its
    // key), so the survivor is the first row at or under the stale directory.
    const nextKey = findFolderRowKey(
      section,
      collapsedIn(section),
      (p) => p === dir || p.startsWith(`${dir}/`),
    );
    // Null = the folder's files are gone entirely; the cursor just clears.
    setActiveFolderKey(nextKey);
    // Post-commit the old row is already unmounted, so orphaned focus is the
    // whole signal — a caret parked in the filter input during a background
    // refresh must stay where it is.
    if (nextKey !== null && focusIsOrphaned()) focusRow(nextKey);
  }, [activeFolderKey, navIndex]);
  const mutating = stage.isPending || unstage.isPending;
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
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorKey(key);
      return;
    }
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
  }

  // Toggle one file's staged state — the row's +/- button and the single menu.
  function handleToggle(entry: FileEntry, staged: boolean) {
    if (staged) {
      void unstage.mutateAsync(unstagePaths(entry)).catch(onError);
      return;
    }
    // Fire-time guard: the affordances are already disabled, but a later call
    // site must not reach a `git add` that dies reading the device.
    if (!canStage(entry)) return;
    void stage.mutateAsync([literalPathspec(entry.path)]).catch(onError);
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
    let swallowedByCollapse = false;
    if (treeMode) {
      // Leaving tree mode: the folder rows go, so a cursor parked on one takes
      // the file row the list keeps, or the control that owns the swap. The
      // claim is DEFERRED: the file row is mounted in the old layout, but the
      // flip's reorder can carry it out of the window — focusing it now would
      // arm nothing for that exit.
      if (activeFolderKey !== null && focusLeavingRow(activeFolderKey)) {
        if (activeKey !== null) deferFocusRow(activeKey, nextMode);
        else viewToggleRef.current?.focus();
      }
    } else {
      // Collapse state outlives list mode by design, so entering tree mode can
      // hide rows selected while they were flat — prune them as a collapse does.
      setSelectedKeys((prev) => pruneHiddenKeys(prev, collapsedFolders));
      // The same collapse can swallow the focused file row: park the cursor on
      // the folder that now stands for it. That folder row cannot exist before
      // the flip, so the claim is armed for it outright.
      if (selectedFile && activeKey !== null) {
        const section = selectedFile.staged ? "staged" : "unstaged";
        const collapsed = collapsedIn(section);
        swallowedByCollapse = [...collapsed].some((dir) =>
          selectedFile.path.startsWith(`${dir}/`),
        );
        if (swallowedByCollapse && focusLeavingRow(activeKey)) {
          const swallowing = findFolderRowKey(
            section,
            collapsed,
            (path) =>
              collapsed.has(path) && selectedFile.path.startsWith(`${path}/`),
          );
          if (swallowing !== null) {
            setActiveFolderKey(swallowing);
            deferFocusRow(swallowing, nextMode);
          } else viewToggleRef.current?.focus();
        }
      }
    }
    // Both directions re-sort the rows (tree mode puts folders first), so a file
    // cursor whose row survives visible can still leave the window. Its row is
    // mounted right now, so the claim is armed directly for the post-flip
    // window; if the row never moves, focus survives and the claim no-ops.
    if (
      !swallowedByCollapse &&
      activeFolderKey === null &&
      activeKey !== null &&
      focusLeavingRow(activeKey)
    )
      deferFocusRow(activeKey, nextMode);
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
    // A directory row carries no file actions, so it takes the whole-tree menu.
    if (key && !key.startsWith("folder:")) {
      const staged = key.startsWith("staged:");
      const path = key.slice(key.indexOf(":") + 1);
      const entry = entries.find((en) => en.path === path);
      if (entry) {
        setMenuTarget({ kind: "row", entry, staged });
        return;
      }
    }
    setMenuTarget({ kind: "global" });
  }

  function stageAll() {
    void stage
      .mutateAsync(stageableUnstaged.map((e) => literalPathspec(e.path)))
      .catch(onError);
  }

  function unstageAll() {
    void unstage
      .mutateAsync(stagedEntries.flatMap(unstagePaths))
      .catch(onError);
  }

  // Bulk stage/unstage of the selection. Direction comes from the section the
  // row was right-clicked in; re-staging an already-staged path (or vice versa)
  // is a harmless git no-op, so every selected file ends up in that state.
  async function stageSelected() {
    if (stageableSelected.length === 0) return;
    try {
      await stage.mutateAsync(
        stageableSelected.map((e) => literalPathspec(e.path)),
      );
      setSelectedKeys(new Set());
    } catch (e) {
      onError(e);
    }
  }

  async function unstageSelected() {
    if (selectionCount === 0) return;
    try {
      await unstage.mutateAsync(selectedEntries.flatMap(unstagePaths));
      setSelectedKeys(new Set());
    } catch (e) {
      onError(e);
    }
  }

  function requestDiscardSelected() {
    if (selectionCount > 0)
      setDiscardScope({ kind: "files", entries: selectedEntries });
  }

  function requestStashSelected() {
    if (selectionCount > 0)
      setStashScope({ kind: "files", entries: selectedEntries });
  }

  // Bulk ignore: add a `/path` line per selected file (any kind). The Rust side
  // de-dupes and skips lines already present.
  async function ignoreSelected() {
    if (selectionCount === 0) return;
    const patterns = selectedEntries.map((e) => `/${globLiteralPath(e.path)}`);
    try {
      const added = await appendIgnore.mutateAsync(patterns);
      toast.success(ignoreToast(added, patterns.length, ".gitignore"));
      setSelectedKeys(new Set());
    } catch (e) {
      onError(e);
    }
  }

  // Bulk AI-exclude: add a `/path` line per selected file — the leading slash
  // anchors each pattern to THIS file rather than every file with that name.
  // A path holding `\` contributes a second line, so the count below is LINES,
  // which is what the toast names. The Rust side skips lines already in EFFECT.
  async function aiExcludeSelected() {
    if (selectionCount === 0) return;
    // Deduped: a literal `weird\name.env` and a real `weird/name.env` both emit
    // the `/`-separated line, and the duplicate would read as a false partial
    // ("Added 2 of 3") once the Rust side collapses it.
    const patterns = [
      ...new Set(
        selectedEntries.flatMap((e) => aiExcludePatternLinesForPath(e.path)),
      ),
    ];
    try {
      const added = await appendAiIgnore.mutateAsync(patterns);
      toast.success(
        ignoreToast(added, patterns.length, ".gitdesktop/aiignore"),
      );
      setSelectedKeys(new Set());
    } catch (e) {
      onError(e);
    }
  }

  // Bulk untrack: `git rm --cached` the tracked files in the selection (kept on
  // disk) + add their ignore lines, in one shot.
  async function untrackSelected() {
    if (selectedTracked.length === 0) return;
    try {
      await untrack.mutateAsync({
        pathspecs: selectedTracked.map((e) => literalPathspec(e.path)),
        ignorePatterns: selectedTracked.map(
          (e) => `/${globLiteralPath(e.path)}`,
        ),
      });
      toast.success(
        `Untracked ${selectedTracked.length} files — kept on disk, added to .gitignore`,
      );
      setSelectedKeys(new Set());
    } catch (e) {
      onError(e);
    }
  }

  async function confirmDiscard() {
    if (!discardScope) return;
    const finish = () => {
      setDiscardScope(null);
      setSelectedKeys(new Set());
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
    const finish = () => {
      setStashScope(null);
      setSelectedKeys(new Set());
    };
    if (stashScope.kind === "all") {
      try {
        await stashAll.mutateAsync(undefined);
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
      // into the stash; `targets` stays raw for the toast below.
      const matched = await stashPaths.mutateAsync(
        targets.map(literalPathspec),
      );
      // `matched` is false when the paths matched nothing, so no stash exists to
      // report — the selection no longer had changes when git ran.
      if (matched) {
        toast.success(
          targets.length === 1
            ? `Stashed ${targets[0]}`
            : `Stashed ${targets.length} files`,
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
    !mutating && stageableSelected.some((e) => e.unstaged !== null),
  );
  useHotkeyAction(
    "unstage-selected-files",
    () => void unstageSelected(),
    !mutating && selectedEntries.some((e) => e.staged !== null),
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
  useHotkeyAction(
    "resolve-conflict-ai",
    () => {
      if (selectedFile && conflictedPaths.includes(selectedFile.path)) {
        startResolveOne(selectedFile.path, repoPath);
      } else {
        startResolveAll(conflictedPaths, repoPath);
      }
    },
    canResolveConflicts,
  );

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
        {/* Outside the aria-busy subtree, for the same reason as the shared
            skeleton component. It may announce for a load that resolves inside
            the 150ms visual delay — a polite region, accepted. */}
        <span role="status" className="sr-only">
          Loading changes…
        </span>
        <div
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
  const discardFiles =
    shownDiscardScope?.kind === "files" ? shownDiscardScope.entries : [];
  const discardOne = discardFiles.length === 1 ? discardFiles[0] : null;
  const discardTitle =
    shownDiscardScope?.kind === "all"
      ? "Discard all changes?"
      : discardOne
        ? "Discard changes?"
        : `Discard ${discardFiles.length} changes?`;
  // Only untracked entries reach the recycle bin, so only they can be the ones
  // deleted outright; "all" discards the whole tree, not just what's on screen.
  const discardHasReserved = (
    shownDiscardScope?.kind === "all" ? entries : discardFiles
  ).some((e) => e.unstaged === "untracked" && isReservedName(e));
  const discardBody = ((): string => {
    switch (true) {
      case shownDiscardScope?.kind === "all":
        return `All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;
      case discardOne !== null && discardOne.unstaged !== "untracked":
        return `Unstaged changes to ${discardOne.path} will be restored to the last committed version. This cannot be undone.`;
      case discardOne !== null && discardHasReserved:
        return `${discardOne.path} is untracked. Its Windows-reserved name can't go to the recycle bin, so it will be deleted permanently.`;
      case discardOne !== null:
        return `${discardOne.path} is untracked — it will be moved to the recycle bin.`;
      default:
        return `Changes to ${discardFiles.length} files will be discarded — tracked files are restored and untracked files moved to the recycle bin. This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;
    }
  })();

  const stashFiles =
    shownStashScope?.kind === "files" ? shownStashScope.entries : [];
  const stashOne = stashFiles.length === 1 ? stashFiles[0] : null;
  const stashTitle =
    shownStashScope?.kind === "all"
      ? "Stash all changes?"
      : stashOne
        ? "Stash change?"
        : `Stash ${stashFiles.length} changes?`;
  const stashBody =
    shownStashScope?.kind === "all"
      ? 'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.'
      : stashOne
        ? `${stashOne.path} is saved to the stash and removed from your working tree. "Pop latest stash" restores it.`
        : `${stashFiles.length} selected files are saved to the stash and removed from your working tree. "Pop latest stash" restores them.`;

  // One row's inner content, closing over the panel's selection/mutation state.
  // Passed to the virtualized list so all that state stays here and only the
  // virtualizer instance lives in the keyed leaf.
  const renderRow = (row: FlatRow): ReactNode => {
    if (row.type === "header")
      return (
        <div
          data-section-header
          className={cn(
            "flex items-center justify-between pr-1 pl-2",
            // Gap only between the staged and unstaged sections, never at the
            // very top of the list.
            row.section === "unstaged" && stagedEntries.length > 0 && "pt-2",
          )}
        >
          <h3 className="py-1 text-xs font-medium text-muted-foreground">
            {row.section === "staged"
              ? `Staged (${row.count})`
              : `Changes (${row.count})`}
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
          tabIndex={0}
          className="flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs text-muted-foreground hover:bg-muted/60"
          style={{ paddingLeft: 8 + row.depth * 12 }}
          onClick={() => handleFolderActivate(row)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
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
        stat={statFor(row.entry, row.staged)}
        selected={selectedKeys.has(keyOf(row.entry.path, row.staged))}
        active={
          selectedFile?.path === row.entry.path &&
          selectedFile.staged === row.staged
        }
        treeDisplay={treeMode}
        indentPx={treeMode ? (row.depth ?? 0) * 12 : undefined}
        onSelect={handleSelect}
        onToggle={handleToggle}
      />
    );
  };

  return (
    // Calm fade as data replaces the loading skeleton (runs once on mount; a
    // one-shot opacity fade is the existing tw-animate-css idiom, lighter than
    // wrapping this whole tree in a motion component). Reduced-motion-safe.
    <div className="flex min-h-0 flex-1 flex-col motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
      <ConflictBanner repoPath={repoPath} conflictedPaths={conflictedPaths} />

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
                          <span className="flex-1">{FILTER_LABELS[kind]}</span>
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
              <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                <InfoIcon className="size-3.5 shrink-0" />
                <span className="flex-1 leading-snug">
                  {formatBinding("mod")}-click to select files individually,
                  Shift-click for a range.
                </span>
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
              </div>
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
              activeRowKey={cursorKey}
              nothingMatches={nothingMatches}
              onClearFilter={() => {
                setFilterText("");
                setActiveKinds(new Set());
              }}
              onListKeyDown={handleListKeyDown}
              onListFocus={handleRowFocus}
              onListEl={handleListEl}
              onContextMenuCapture={handleContextMenu}
              onCursorScrolled={claimPendingFocus}
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
                selectionCount={selectionCount}
                stageableSelectionCount={stageableSelected.length}
                selectedTrackedCount={selectedTracked.length}
                actions={{
                  discardAll: () => setDiscardScope({ kind: "all" }),
                  stashAll: () => setStashScope({ kind: "all" }),
                  stageSelected: () => void stageSelected(),
                  unstageSelected: () => void unstageSelected(),
                  discardSelected: requestDiscardSelected,
                  stashSelected: requestStashSelected,
                  ignoreSelected: () => void ignoreSelected(),
                  untrackSelected: () => void untrackSelected(),
                  toggle: handleToggle,
                  resolveWithAi: (path) => startResolveOne(path, repoPath),
                  discardFile: (entry) =>
                    setDiscardScope({ kind: "files", entries: [entry] }),
                  stashFile: (entry) =>
                    setStashScope({ kind: "files", entries: [entry] }),
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
  activeRowKey,
  nothingMatches,
  onClearFilter,
  onListKeyDown,
  onListFocus,
  onListEl,
  onContextMenuCapture,
  onCursorScrolled,
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
  /** The cursor row — a file or (tree mode) a folder — kept scrolled into view. */
  activeRowKey: string | null;
  nothingMatches: boolean;
  onClearFilter: () => void;
  onListKeyDown: (e: KeyboardEvent) => void;
  /** Every focus inside the list, delegated: the panel keeps its folder cursor
   *  in step with the row focus landed in. */
  onListFocus: (e: FocusEvent) => void;
  /** Hands the mounted scroll container up to the panel, which queries rows
   *  through it. Must be referentially stable — it rides the element's ref. */
  onListEl: (el: HTMLDivElement | null) => void;
  onContextMenuCapture: (e: MouseEvent) => void;
  /** Called a frame after the cursor row is scrolled to, so the panel can focus
   *  a row it could not reach while unmounted. False = still unmounted, retry. */
  onCursorScrolled: () => boolean;
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
  // filter, and (tree mode) the layout and which directories are collapsed.
  const flatRowsRef = useRef(flatRows);
  flatRowsRef.current = flatRows;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps re-mint the identity; the ref supplies the rows
  const getItemKey = useCallback(
    (index: number) => {
      const row = flatRowsRef.current[index];
      return row ? rowKeyOf(row) : index;
    },
    [entries, text, activeKinds, viewMode, collapsedFolders],
  );
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active change
  useEffect(() => {
    if (activeFlatIndex < 0) return;
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
