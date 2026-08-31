import { Popover } from "@base-ui/react/popover";
import {
  CaretRightIcon,
  FunnelIcon,
  InfoIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { usePanelPortalContainer } from "@/components/panel-portal";
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
  useCompareBranches,
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
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
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

/** A flattened row in the virtualized changes list: a section header or a file.
 *  One flat list (not two nested sections) keeps virtualization, cross-section
 *  arrow-key navigation, and range selection in a single index space. */
type FlatRow =
  | { type: "header"; section: "staged" | "unstaged"; count: number }
  | { type: "file"; entry: FileEntry; staged: boolean };

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
  const [filterText, setFilterText] = useState("");
  const [activeKinds, setActiveKinds] = useState<Set<FilterKind>>(new Set());
  const [stashesOpen, setStashesOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  // The one shared context menu acts on whatever was right-clicked.
  const [menuTarget, setMenuTarget] = useState<MenuTarget>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // State-backed (not a plain ref) so the virtualizer observes the scroll
  // element the instant it mounts — the list area is only rendered once there
  // are changes, and a plain ref would leave the first paint blank.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

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
  const aheadOfDefault = useCompareBranches(
    repoPath,
    canCompareDefault ? defaultName : null,
    canCompareDefault ? currentName : null,
  );
  const proposeCount = canCompareDefault
    ? (aheadOfDefault.data?.ahead.length ?? 0)
    : 0;

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
  const nothingMatches =
    entries.length > 0 &&
    stagedEntries.length === 0 &&
    unstagedEntries.length === 0;

  // The rows in render order, so ArrowUp/Down can walk the selection
  // across both sections.
  const visibleRows = [
    ...stagedEntries.map((entry) => ({ entry, staged: true })),
    ...unstagedEntries.map((entry) => ({ entry, staged: false })),
  ];
  const keyOf = (path: string, staged: boolean) =>
    `${staged ? "staged" : "unstaged"}:${path}`;
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
  // Untracking only applies to files git already tracks (not fresh untracked
  // files or brand-new staged adds) — mirrors FileRow's per-file rule.
  const selectedTracked = selectedEntries.filter(
    (e) => e.unstaged !== "untracked" && e.staged !== "added",
  );

  // One flattened list (section headers + their files) drives a single
  // virtualizer, so a working tree with thousands of changed files only renders
  // a window of rows instead of mounting every row (which used to crash).
  const flatRows: FlatRow[] = [];
  if (stagedEntries.length > 0) {
    flatRows.push({
      type: "header",
      section: "staged",
      count: stagedEntries.length,
    });
    for (const entry of stagedEntries)
      flatRows.push({ type: "file", entry, staged: true });
  }
  if (unstagedEntries.length > 0) {
    flatRows.push({
      type: "header",
      section: "unstaged",
      count: unstagedEntries.length,
    });
    for (const entry of unstagedEntries)
      flatRows.push({ type: "file", entry, staged: false });
  }
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => {
      const r = flatRows[i];
      if (r.type === "file") return 28;
      // The "Changes" header carries a top gap only when it follows the staged
      // section; bake that into the estimate so the first paint never overlaps.
      return r.section === "unstaged" && stagedEntries.length > 0 ? 40 : 32;
    },
    overscan: 16,
  });
  // Flat index of the active file row, so we can keep it scrolled into view
  // under virtualization (its own DOM node may not be mounted).
  const activeFlatIndex = activeKey
    ? flatRows.findIndex(
        (r) => r.type === "file" && keyOf(r.entry.path, r.staged) === activeKey,
      )
    : -1;

  // Arrow keys walk the rows across both sections; Shift extends from the
  // anchor, a plain arrow collapses to the single active row.
  const rowKey = (r: { entry: FileEntry; staged: boolean }) =>
    keyOf(r.entry.path, r.staged);
  const onListKeyDown = listKeyboardNav({
    items: visibleRows,
    activeIndex: activeKey
      ? visibleRows.findIndex((r) => rowKey(r) === activeKey)
      : -1,
    rowKey,
    onActivate: (row, to, shift) => {
      const key = rowKey(row);
      select(row.entry, row.staged);
      if (shift && anchorKey) {
        const keys = visibleRows.map(rowKey);
        const a = keys.indexOf(anchorKey);
        if (a !== -1) {
          const [lo, hi] = a <= to ? [a, to] : [to, a];
          setSelectedKeys(new Set(keys.slice(lo, hi + 1)));
        }
      } else {
        setSelectedKeys(new Set([key]));
        setAnchorKey(key);
      }
    },
  });

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
  // Keep the active row scrolled into view as the selection moves — under
  // virtualization its DOM node may not be mounted, so scroll by index.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active change
  useEffect(() => {
    if (activeFlatIndex >= 0)
      rowVirtualizer.scrollToIndex(activeFlatIndex, { align: "auto" });
  }, [activeFlatIndex]);
  // Jump back to the top whenever the filter changes the visible set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => {
    rowVirtualizer.scrollToOffset(0);
  }, [text, activeKinds]);
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
    if (mods.shift && anchorKey) {
      const keys = visibleRows.map((r) => keyOf(r.entry.path, r.staged));
      const a = keys.indexOf(anchorKey);
      const b = keys.indexOf(key);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelectedKeys(new Set(keys.slice(lo, hi + 1)));
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

  // Toggle one file's staged state — the row's +/- button and the single menu.
  function handleToggle(entry: FileEntry, staged: boolean) {
    if (staged) unstage.mutate(unstagePaths(entry), { onError });
    else stage.mutate([literalPathspec(entry.path)], { onError });
  }

  // Single-file ignore / untrack (the per-row menu); the bulk equivalents are
  // ignoreSelected / untrackSelected below.
  function ignoreOne(pattern: string, label: string) {
    appendIgnore.mutate([pattern], {
      onSuccess: (added) =>
        toast.success(
          added === 0
            ? `"${label}" is already in .gitignore`
            : `Added "${label}" to .gitignore`,
        ),
      onError,
    });
  }
  function aiExcludeOne(patterns: string[], label: string) {
    appendAiIgnore.mutate(patterns, {
      onSuccess: (added) =>
        toast.success(
          added === 0
            ? `"${label}" is already in .gitdesktop/aiignore`
            : `Added "${label}" to .gitdesktop/aiignore`,
        ),
      onError,
    });
  }
  function untrackOne(pathspec: string, ignorePattern: string, label: string) {
    untrack.mutate(
      { pathspecs: [pathspec], ignorePatterns: [ignorePattern] },
      {
        onSuccess: () =>
          toast.success(
            `Untracked ${label} — kept on disk, added to .gitignore`,
          ),
        onError,
      },
    );
  }

  // Right-click anywhere in the list: act on the row under the cursor, or fall
  // back to the whole-tree menu for section headers and blank space.
  function handleContextMenu(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest("[data-row]");
    const key = rowEl?.getAttribute("data-row");
    if (key) {
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
    stage.mutate(
      unstagedEntries.map((e) => literalPathspec(e.path)),
      { onError },
    );
  }

  function unstageAll() {
    unstage.mutate(stagedEntries.flatMap(unstagePaths), { onError });
  }

  // Bulk stage/unstage of the selection. Direction comes from the section the
  // row was right-clicked in; re-staging an already-staged path (or vice versa)
  // is a harmless git no-op, so every selected file ends up in that state.
  function stageSelected() {
    if (selectionCount === 0) return;
    stage.mutate(
      selectedEntries.map((e) => literalPathspec(e.path)),
      { onError, onSuccess: () => setSelectedKeys(new Set()) },
    );
  }

  function unstageSelected() {
    if (selectionCount === 0) return;
    unstage.mutate(selectedEntries.flatMap(unstagePaths), {
      onError,
      onSuccess: () => setSelectedKeys(new Set()),
    });
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
  function ignoreSelected() {
    if (selectionCount === 0) return;
    const patterns = selectedEntries.map((e) => `/${globLiteralPath(e.path)}`);
    appendIgnore.mutate(patterns, {
      onSuccess: (added) => {
        toast.success(ignoreToast(added, patterns.length, ".gitignore"));
        setSelectedKeys(new Set());
      },
      onError,
    });
  }

  // Bulk AI-exclude: add a `/path` line per selected file — the leading slash
  // anchors each pattern to THIS file rather than every file with that name.
  // A path holding `\` contributes a second line, so the count below is LINES,
  // which is what the toast names. The Rust side skips lines already in EFFECT.
  function aiExcludeSelected() {
    if (selectionCount === 0) return;
    // Deduped: a literal `weird\name.env` and a real `weird/name.env` both emit
    // the `/`-separated line, and the duplicate would read as a false partial
    // ("Added 2 of 3") once the Rust side collapses it.
    const patterns = [
      ...new Set(
        selectedEntries.flatMap((e) => aiExcludePatternLinesForPath(e.path)),
      ),
    ];
    appendAiIgnore.mutate(patterns, {
      onSuccess: (added) => {
        toast.success(
          ignoreToast(added, patterns.length, ".gitdesktop/aiignore"),
        );
        setSelectedKeys(new Set());
      },
      onError,
    });
  }

  // Bulk untrack: `git rm --cached` the tracked files in the selection (kept on
  // disk) + add their ignore lines, in one shot.
  function untrackSelected() {
    if (selectedTracked.length === 0) return;
    untrack.mutate(
      {
        pathspecs: selectedTracked.map((e) => literalPathspec(e.path)),
        ignorePatterns: selectedTracked.map(
          (e) => `/${globLiteralPath(e.path)}`,
        ),
      },
      {
        onSuccess: () => {
          toast.success(
            `Untracked ${selectedTracked.length} files — kept on disk, added to .gitignore`,
          );
          setSelectedKeys(new Set());
        },
        onError,
      },
    );
  }

  function confirmDiscard() {
    if (!discardScope) return;
    const finish = () => {
      setDiscardScope(null);
      setSelectedKeys(new Set());
    };
    if (discardScope.kind === "all") {
      discardAll.mutate(undefined, {
        onSuccess: () => {
          toast.success("All changes discarded");
          finish();
        },
        onError: (e) => {
          onError(e);
          finish();
        },
      });
      return;
    }
    const targets = discardScope.entries.map((e) => ({
      path: e.path,
      untracked: e.unstaged === "untracked",
    }));
    discardPaths.mutate(targets, {
      onSuccess: () => {
        toast.success(
          targets.length === 1
            ? `Discarded changes to ${targets[0].path}`
            : `Discarded changes to ${targets.length} files`,
        );
        finish();
      },
      onError: (e) => {
        onError(e);
        finish();
      },
    });
  }

  function confirmStash() {
    if (!stashScope) return;
    const finish = () => {
      setStashScope(null);
      setSelectedKeys(new Set());
    };
    if (stashScope.kind === "all") {
      stashAll.mutate(undefined, {
        onSuccess: () => {
          toast.success("Changes stashed");
          finish();
        },
        onError: (e) => {
          onError(e);
          finish();
        },
      });
      return;
    }
    const targets = stashScope.entries.map((e) => e.path);
    // Literal pathspecs so a `[slug]`-style path can't sweep a sibling's work
    // into the stash; `targets` stays raw for the toast below.
    stashPaths.mutate(targets.map(literalPathspec), {
      // `matched` is false when the paths matched nothing, so no stash exists to
      // report — the selection no longer had changes when git ran.
      onSuccess: (matched) => {
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
      },
      onError: (e) => {
        onError(e);
        finish();
      },
    });
  }

  useHotkeyAction(
    "stage-all",
    stageAll,
    !mutating && unstagedEntries.length > 0,
  );
  useHotkeyAction(
    "unstage-all",
    unstageAll,
    !mutating && stagedEntries.length > 0,
  );
  useHotkeyAction(
    "stage-selected-files",
    stageSelected,
    !mutating && selectedEntries.some((e) => e.unstaged !== null),
  );
  useHotkeyAction(
    "unstage-selected-files",
    unstageSelected,
    !mutating && selectedEntries.some((e) => e.staged !== null),
  );
  useHotkeyAction(
    "focus-filter",
    () => filterRef.current?.focus(),
    entries.length > 0,
  );
  // Resolve the selected conflicted file with AI, or start an all-conflicts run
  // when the selection isn't a conflict. Palette-only (no default binding).
  useHotkeyAction(
    "resolve-conflict-ai",
    () => {
      if (selectedFile && conflictedPaths.includes(selectedFile.path)) {
        startResolveOne(selectedFile.path);
      } else {
        startResolveAll(conflictedPaths);
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
              compare + forge queries are gated on status resolving, so the
              PR / View-on-GitHub buttons cannot be present yet (3 h-7 buttons
              + gaps). They pop in as those queries land — that later shift is
              the empty state's own, independent of this placeholder. */}
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
  const discardBody =
    shownDiscardScope?.kind === "all"
      ? "All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin."
      : discardOne
        ? discardOne.unstaged === "untracked"
          ? `${discardOne.path} is untracked — it will be moved to the recycle bin.`
          : `Unstaged changes to ${discardOne.path} will be restored to the last committed version. This cannot be undone.`
        : `Changes to ${discardFiles.length} files will be discarded — tracked files are restored and untracked files moved to the recycle bin. This cannot be undone.`;

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
                  onClick={() =>
                    settings.data &&
                    saveSettings.mutate({
                      ...settings.data,
                      showSelectionHint: false,
                    })
                  }
                  className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2 hover:no-underline"
                >
                  Don't show again
                </button>
              </div>
            )}

          <ContextMenu>
            <ContextMenuTrigger
              render={
                // The whole list is one right-click target + one virtualizer,
                // so thousands of changed files no longer mount thousands of
                // menus/rows. `handleContextMenu` (capture phase, so it runs
                // before the menu opens) records which row/header was hit.
                <div
                  ref={setScrollEl}
                  className="min-h-0 flex-1 overflow-y-auto"
                  onKeyDown={onListKeyDown}
                  onContextMenuCapture={handleContextMenu}
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
                    onClick={() => {
                      setFilterText("");
                      setActiveKinds(new Set());
                    }}
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
                        key={
                          row.type === "header"
                            ? `header:${row.section}`
                            : keyOf(row.entry.path, row.staged)
                        }
                        data-index={vi.index}
                        ref={rowVirtualizer.measureElement}
                        className="absolute top-0 left-0 w-full"
                        style={{ transform: `translateY(${vi.start}px)` }}
                      >
                        {row.type === "header" ? (
                          <div
                            data-section-header
                            className={cn(
                              "flex items-center justify-between pr-1 pl-2",
                              // Gap only between the staged and unstaged sections,
                              // never at the very top of the list.
                              row.section === "unstaged" &&
                                stagedEntries.length > 0 &&
                                "pt-2",
                            )}
                          >
                            <h3 className="py-1 text-xs font-medium text-muted-foreground">
                              {row.section === "staged"
                                ? `Staged (${row.count})`
                                : `Changes (${row.count})`}
                            </h3>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-muted-foreground"
                              disabled={mutating}
                              onClick={
                                row.section === "staged" ? unstageAll : stageAll
                              }
                            >
                              {row.section === "staged"
                                ? "Unstage all"
                                : "Stage all"}
                            </Button>
                          </div>
                        ) : (
                          <FileRow
                            entry={row.entry}
                            kind={
                              (row.staged
                                ? row.entry.staged
                                : row.entry.unstaged) ?? "modified"
                            }
                            staged={row.staged}
                            disabled={mutating}
                            stat={statFor(row.entry, row.staged)}
                            selected={selectedKeys.has(
                              keyOf(row.entry.path, row.staged),
                            )}
                            active={
                              selectedFile?.path === row.entry.path &&
                              selectedFile.staged === row.staged
                            }
                            onSelect={handleSelect}
                            onToggle={handleToggle}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ContextMenuTrigger>
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
                selectedTrackedCount={selectedTracked.length}
                actions={{
                  discardAll: () => setDiscardScope({ kind: "all" }),
                  stashAll: () => setStashScope({ kind: "all" }),
                  stageSelected,
                  unstageSelected,
                  discardSelected: requestDiscardSelected,
                  stashSelected: requestStashSelected,
                  ignoreSelected,
                  untrackSelected,
                  toggle: handleToggle,
                  resolveWithAi: startResolveOne,
                  discardFile: (entry) =>
                    setDiscardScope({ kind: "files", entries: [entry] }),
                  stashFile: (entry) =>
                    setStashScope({ kind: "files", entries: [entry] }),
                  viewHistory: setHistoryPath,
                  blame: setBlamePath,
                  ignore: ignoreOne,
                  untrack: untrackOne,
                  aiExclude: aiExcludeOne,
                  aiExcludeSelected,
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
        onConfirm={confirmDiscard}
      />

      <ConfirmDialog
        open={stashScope !== null}
        onCancel={() => setStashScope(null)}
        title={stashTitle}
        body={stashBody}
        confirmLabel={shownStashScope?.kind === "all" ? "Stash all" : "Stash"}
        pending={stashPaths.isPending || stashAll.isPending}
        onConfirm={confirmStash}
      />
    </div>
  );
}
