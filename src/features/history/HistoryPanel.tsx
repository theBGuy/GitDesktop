import {
  ArrowLeftIcon,
  ArrowUpIcon,
  GitCommitIcon,
  MagnifyingGlassIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AmendForcePushDialog } from "@/features/commit/AmendForcePushDialog";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { useAppForm } from "@/lib/form";
import { gitCommitDetails, gitRecentCommits } from "@/lib/git/api";
import {
  useBranches,
  useCheckoutCommit,
  useCherryPick,
  useCommitAuthorAvatarIndex,
  useCommitSearch,
  useCreateBranch,
  useCreateTag,
  useHoverPrefetch,
  useLog,
  useOpState,
  usePrefetchCommit,
  usePushTag,
  useRepoStatus,
  useRevertCommit,
  useUndoCommit,
  useUnpushedCount,
} from "@/lib/git/queries";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { CommitSummary, RewriteStep } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { CommitContextMenuItems } from "./CommitContextMenu";
import {
  checkoutCommitConfirm,
  checkoutCommitSuccessToast,
  cherryPickCommitConfirm,
  revertCommitConfirm,
  UNDO_ROOT_COMMIT_CONFIRM,
} from "./commit-confirms";
import { EditHistoryDialog } from "./EditHistoryDialog";
import {
  CherryPickOntoDialog,
  CreateRefFromCommitDialog,
  createRefFromCommitFormOpts,
  DeleteTagDialog,
  ResetCommitDialog,
} from "./HistoryDialogs";
import { SquashDialog } from "./RewriteDialogs";
import { useAmendWithConfirm } from "./useAmendCommit";

const FILTER_PLACEHOLDER = "Filter loaded commits, or search all history";

export function HistoryPanel({ repoPath }: { repoPath: string }) {
  const log = useLog(repoPath);
  // Batch-resolve commit-author avatars for the log's authors (GitHub-only,
  // deduped by react-query across the History surfaces).
  useCommitAuthorAvatarIndex(repoPath);
  const status = useRepoStatus(repoPath);
  const opState = useOpState(repoPath);
  const undoCommit = useUndoCommit(repoPath);
  const selectedCommitHash = useUiStore((s) => s.selectedCommitHash);
  const selectCommit = useUiStore((s) => s.selectCommit);
  const prefetchCommit = usePrefetchCommit(repoPath);
  const hoverPrefetch = useHoverPrefetch();
  const setCommitDraft = useUiStore((s) => s.setCommitDraft);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  const checkoutCommit = useCheckoutCommit(repoPath);
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const createBranch = useCreateBranch(repoPath);
  const createTag = useCreateTag(repoPath);
  const pushTag = usePushTag(repoPath);
  const branches = useBranches(repoPath);

  const [resetHash, setResetHash] = useState<string | null>(null);
  const [branchHash, setBranchHash] = useState<string | null>(null);
  const [tagHash, setTagHash] = useState<string | null>(null);
  // Both dialogs' descriptions are built at their call sites below.
  const shownBranchHash = useRetained(branchHash);
  const shownTagHash = useRetained(tagHash);
  // Multi-/range-selection for "cherry-pick to branch". Kept separate from the
  // ui store's focused commit (which drives the diff panel).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  // Hashes to copy, oldest-first, and the chosen destination branch.
  const [pickOntoHashes, setPickOntoHashes] = useState<string[] | null>(null);
  const [pickOntoBranch, setPickOntoBranch] = useState("");
  const [filterText, setFilterText] = useState("");
  // "Search all history" mode: server-side message grep across every commit,
  // not just the loaded pages. Kept separate from the operational log so the
  // rewrite/amend actions still see contiguous recent history.
  const [searchMode, setSearchMode] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  // The native scroll container that hosts the virtualized list. Kept in STATE
  // (not a ref) so attaching it re-renders and the child's virtualizer
  // re-initializes with the real node — a plain ref stays null at the
  // virtualizer's mount effect, so getVirtualItems() returns [] and no rows
  // paint even though the spacer has height. Mirrors ChangesPanel's `setScrollEl`
  // callback-ref wiring on its own Base-UI ContextMenuTrigger render element.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Tag pending deletion, plus whether to delete it from origin too.
  const [deleteTagName, setDeleteTagName] = useState<string | null>(null);
  const [deleteTagRemote, setDeleteTagRemote] = useState(false);
  // History rewriting (quick squash + the Edit-history editor), unpushed only.
  const [squashCtx, setSquashCtx] = useState<{
    base: string;
    steps: RewriteStep[];
    count: number;
    defaultMessage: string;
  } | null>(null);
  const [editHistoryOpen, setEditHistoryOpen] = useState(false);
  // The commit (+ its row index) the one shared context menu acts on.
  const [menuTarget, setMenuTarget] = useState<{
    commit: CommitSummary;
    index: number;
  } | null>(null);

  const searchActive = searchMode && filterText.trim().length > 0;
  const search = useCommitSearch(
    repoPath,
    searchActive ? filterText.trim() : "",
  );

  const onError = (e: unknown) => toastError(e);

  const currentBranch = status.data?.branch?.name ?? null;
  // Agent-session branches (`gd/session/*`) are app-internal — never offer them
  // as a cherry-pick target (it would switch to and cherry-pick onto one), like
  // ComparePanel / BranchSwitcher. Archived branches are hidden here for the same
  // reason they are hidden elsewhere: they were archived to get them out of the way.
  const pickOntoCandidates = (branches.data ?? []).filter(
    (b) => !b.isCurrent && !b.name.startsWith("gd/session/"),
  );
  const targetBranches = pickOntoCandidates.filter((b) => !b.archived);

  const branchForm = useAppForm({
    ...createRefFromCommitFormOpts,
    onSubmit: async ({ value }) => {
      if (!branchHash) return;
      const name = sanitizeRefName(value.name);
      try {
        await createBranch.mutateAsync({
          name,
          checkout: true,
          startPoint: branchHash,
        });
        toast.success(`Created branch ${name}`);
        setBranchHash(null);
      } catch (e) {
        onError(e);
      }
    },
  });

  const tagForm = useAppForm({
    ...createRefFromCommitFormOpts,
    onSubmit: async ({ value }) => {
      if (!tagHash) return;
      const name = sanitizeRefName(value.name);
      try {
        await createTag.mutateAsync({ name, hash: tagHash });
        toast.success(`Created tag ${name}`);
        setTagHash(null);
      } catch (e) {
        onError(e);
      }
    },
  });

  const { requestAmend, forcePushDialog } = useAmendWithConfirm(repoPath);

  // GitHub Desktop-style undo: offered while the latest commit hasn't been
  // pushed anywhere (no upstream, or we're ahead of it).
  const head = status.data?.branch;
  const lastCommit = log.data?.pages[0]?.[0];
  const canUndo = Boolean(
    lastCommit &&
      head &&
      (head.upstream === null || head.upstreamGone || head.ahead > 0),
  );
  // Whether HEAD is a root commit, which sends undo down git's ref-deleting
  // path. The log walks HEAD's ancestry and only stops paging once a page comes
  // up short, so a lone loaded commit with no next page means HEAD has no parent.
  const headIsRoot = log.data?.pages[0]?.length === 1 && !log.hasNextPage;

  async function undoLast() {
    if (!lastCommit) return;
    // Only the root case is lossy enough to ask about: an ordinary undo is gated
    // to unpushed commits and leaves everything staged.
    if (
      headIsRoot &&
      !(await useConfirm.getState().ask(UNDO_ROOT_COMMIT_CONFIRM))
    ) {
      return;
    }
    try {
      // The undo names no commit — it always unwinds whatever HEAD is at the
      // moment it runs — so re-read HEAD across the prompt's await. A commit
      // landing out of band (another window, a terminal) would otherwise be the
      // one undone, under a confirmation that described a different commit.
      const [headNow] = await gitRecentCommits(repoPath, 1);
      if (headNow?.hash !== lastCommit.hash) {
        toast.info("The latest commit changed — nothing was undone.");
        return;
      }
      const details = await gitCommitDetails(repoPath, lastCommit.hash);
      undoCommit.mutate(undefined, {
        onSuccess: () => {
          setCommitDraft(details.subject, details.body);
          setRepoTab("changes");
          toast.success(
            `Undid ${lastCommit.hash.slice(0, 7)} — changes are staged again`,
          );
        },
        onError,
      });
    } catch (e) {
      onError(e);
    }
  }

  // The confirm sits here rather than on the menu items, so the search menu and
  // the single-commit menu can't diverge on whether they ask.
  async function doCheckoutCommit(hash: string) {
    if (!(await useConfirm.getState().ask(checkoutCommitConfirm(hash)))) return;
    checkoutCommit.mutate(hash, {
      onSuccess: () => toast.success(checkoutCommitSuccessToast(hash)),
      onError,
    });
  }

  async function doRevertCommit(hash: string) {
    if (!(await useConfirm.getState().ask(revertCommitConfirm(hash)))) return;
    revertCommit.mutate(hash, { onError });
  }

  // `alreadyApplied` is the one thing the two menus word differently.
  async function doCherryPick(hash: string, alreadyApplied: string) {
    const ok = await useConfirm
      .getState()
      .ask(cherryPickCommitConfirm(hash, currentBranch));
    if (!ok) return;
    cherryPick.mutate(hash, {
      onSuccess: (applied) => {
        if (applied) {
          toast.success(`Cherry-picked ${hash.slice(0, 7)}`);
        } else {
          toast.info(alreadyApplied);
        }
      },
      onError,
    });
  }

  useHotkeyAction("undo-commit", undoLast, canUndo && !undoCommit.isPending);
  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  // Derived commit lists — memoized so the per-render .flat()/.filter()/.map()
  // allocations don't churn (they feed the list + selection gating on every
  // keystroke). Computed before the early returns to satisfy the rules of hooks;
  // harmlessly empty while the log is still loading.
  const commits = useMemo(() => log.data?.pages.flat() ?? [], [log.data]);
  const searchCommits = useMemo(
    () => search.data?.pages.flat() ?? [],
    [search.data],
  );
  // Client-side filter over the loaded pages (subject, author, or SHA).
  const query = filterText.trim().toLowerCase();
  const filteredCommits = useMemo(
    () =>
      query
        ? commits.filter(
            (c) =>
              c.subject.toLowerCase().includes(query) ||
              c.author.toLowerCase().includes(query) ||
              c.hash.toLowerCase().startsWith(query),
          )
        : commits,
    [commits, query],
  );
  // In search mode the list is whole-history grep results; otherwise it's the
  // (client-filtered) loaded pages.
  const visibleCommits = searchActive ? searchCommits : filteredCommits;
  // Squash gating needs the selection's positions in REAL history (not the
  // filtered view), so index against `commits`.
  const selectedIndices = useMemo(
    () =>
      commits
        .map((c, i) => (selected.has(c.hash) ? i : -1))
        .filter((i) => i >= 0),
    [commits, selected],
  );

  // Commits not yet on the remote. Published branch → the top `ahead` commits
  // (ahead of its upstream). Unpublished branch (no upstream) → count them
  // against the remotes, NOT `commits.length`: the fork point and everything
  // below it live on `origin/<base>` and are already published, so only the
  // branch's own commits are unpushed. (Queried only in the no-upstream case.)
  // Drives both the rewrite gating below and the per-row "not pushed" marker.
  // A gone upstream counts as no upstream so the `unpushedVsRemotes` fallback
  // engages and the per-row "not pushed" markers reflect what's truly published.
  const noUpstream =
    head != null && (head.upstream === null || head.upstreamGone);
  const unpushedVsRemotes = useUnpushedCount(repoPath, noUpstream);
  const unpushedCount = head
    ? noUpstream
      ? (unpushedVsRemotes.data ?? 0)
      : head.ahead
    : 0;
  // The unpushed set (top `unpushedCount` of the HEAD-order log), for marking
  // rows. Memoized — the React Compiler won't hoist the .slice/.map/new Set.
  // Auto-clears after a push: useRepoStatus refetches, head.ahead → 0.
  const unpushedHashes = useMemo(
    () => new Set(commits.slice(0, unpushedCount).map((c) => c.hash)),
    [commits, unpushedCount],
  );

  if (log.isPending) {
    return (
      <>
        <div className="border-b p-2">
          {/* A disabled copy of the header below, so the rows don't shift when
              the log lands. */}
          <Input
            disabled
            placeholder={FILTER_PLACEHOLDER}
            className="h-7"
            autoComplete="off"
          />
        </div>
        <div className="flex-1">
          <ListRowSkeletons rows={3} lines={2} indent={false} name="commits" />
        </div>
      </>
    );
  }

  if (commits.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCommitIcon />
          </EmptyMedia>
          <EmptyTitle>No commits yet</EmptyTitle>
          <EmptyDescription>
            Your project's history shows up here. Make a change, then stage and
            commit it to record your first commit.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRepoTab("changes")}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Go to Changes
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  // Shift-extend the selection to a contiguous range of the rendered (possibly
  // filtered) list — shared by the mouse and keyboard paths. Indices are positions
  // in `visibleCommits`.
  function selectRange(from: number, to: number) {
    const [a, b] = [from, to].sort((x, y) => x - y);
    setSelected(new Set(visibleCommits.slice(a, b + 1).map((c) => c.hash)));
  }

  function onRowClick(e: React.MouseEvent, index: number, hash: string) {
    // Keep the diff panel on the clicked commit regardless of modifiers.
    selectCommit(hash);
    // Search results aren't contiguous history — single-select only there.
    if (searchActive) {
      setSelected(new Set([hash]));
      setAnchorIndex(null);
      return;
    }
    if (e.shiftKey && anchorIndex !== null) {
      selectRange(anchorIndex, index);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      setSelected(next);
      setAnchorIndex(index);
    } else {
      setSelected(new Set([hash]));
      setAnchorIndex(index);
    }
  }

  // Right-clicking a commit outside the selection collapses the selection
  // to it (standard desktop behavior) — the context menu then always
  // describes exactly what it acts on.
  function onRowContextMenu(index: number, hash: string) {
    if (!selected.has(hash)) {
      setSelected(new Set([hash]));
      setAnchorIndex(index);
      selectCommit(hash);
    }
  }

  // Arrow keys walk the history selection; Shift extends it from the anchor.
  const onListKeyDown = listKeyboardNav({
    items: visibleCommits,
    activeIndex: visibleCommits.findIndex((c) => c.hash === selectedCommitHash),
    rowKey: (c) => c.hash,
    rowAttr: "data-hash",
    onActivate: (commit, to, shift) => {
      selectCommit(commit.hash);
      if (shift && anchorIndex !== null) {
        selectRange(anchorIndex, to);
      } else {
        setSelected(new Set([commit.hash]));
        setAnchorIndex(to);
      }
    },
  });

  // The commits a context-menu action applies to: the multi-selection when the
  // right-clicked commit is part of it, otherwise just that one commit.
  function effectiveSelection(hash: string): string[] {
    const base =
      selected.has(hash) && selected.size > 1 ? selected : new Set([hash]);
    // Cherry-pick wants oldest-first; the log is newest-first.
    return commits
      .filter((c) => base.has(c.hash))
      .map((c) => c.hash)
      .reverse();
  }

  // Squash: the selection must be >1, contiguous in real history (not the
  // filtered view), entirely unpushed, and have a commit below it as base.
  const squashMax = selectedIndices.at(-1) ?? -1;
  const contiguousInHistory =
    selectedIndices.length > 1 &&
    squashMax - (selectedIndices[0] ?? 0) + 1 === selectedIndices.length;
  const canSquash =
    contiguousInHistory &&
    squashMax < unpushedCount &&
    squashMax + 1 < commits.length &&
    // The replayed range (everything above the base) must be merge-free.
    commits.slice(0, squashMax + 1).every((c) => !c.isMerge);
  // Why squash is unavailable — in particular the easy-to-miss case where a client
  // filter hides commits between the selected ones, so a range that looks adjacent
  // in the filtered view isn't adjacent in real history.
  const squashDisabledHint =
    query && !contiguousInHistory
      ? " (clear the filter — a squash range must be adjacent in history)"
      : " (must be adjacent and unpushed)";

  function openSquash() {
    if (!canSquash) return;
    const minIdx = selectedIndices[0];
    const run = commits.slice(minIdx, squashMax + 1);
    // Steps replay base..HEAD oldest-first with the run collapsed.
    const steps: RewriteStep[] = [
      { hashes: [...run].reverse().map((c) => c.hash), message: "" },
      ...commits
        .slice(0, minIdx)
        .reverse()
        .map((c) => ({ hashes: [c.hash] })),
    ];
    setSquashCtx({
      base: commits[squashMax + 1].hash,
      steps,
      count: run.length,
      defaultMessage: [...run]
        .reverse()
        .map((c) => c.subject)
        .join("\n\n"),
    });
  }

  // Edit history: the top unpushed commits (capped), needing a base below them.
  // Merge commits can't be replayed, so the range stops at the first one. One
  // editable commit is enough (you can reword or drop a single commit).
  const EDIT_MAX = 15;
  const firstMerge = commits.findIndex((c) => c.isMerge);
  let editLen = Math.min(
    unpushedCount,
    EDIT_MAX,
    commits.length,
    firstMerge === -1 ? Number.POSITIVE_INFINITY : firstMerge,
  );
  if (editLen === commits.length && !log.hasNextPage) editLen -= 1;
  // Block editing history while a merge/rebase/cherry-pick/revert is mid-flight —
  // a new edit-rebase would clobber the in-flight one's state (the banner drives
  // it). The backend refuses too; this just keeps the action from looking live.
  const opInProgress = Boolean(
    opState.data?.merging ||
      opState.data?.rebasing ||
      opState.data?.cherryPicking ||
      opState.data?.reverting,
  );
  const canEditHistory = editLen >= 1 && !opInProgress;
  const editHistoryHint = opInProgress
    ? " (finish the operation in Changes first)"
    : "";
  // Why cherry-picking onto a branch is unavailable, in precedence order: an
  // in-flight operation (the pick's own conflict path pauses one), then a repo
  // whose every other branch is archived — offerable-looking, but not offered.
  const pickOntoDisabledHint = (() => {
    if (opInProgress) return " (finish the operation in Changes first)";
    if (targetBranches.length > 0) return "";
    if (pickOntoCandidates.length > 0)
      return " (all other branches are archived — unarchive one first)";
    return " (no other branches)";
  })();
  const canPickOnto = pickOntoDisabledHint === "";
  const editCommits = commits.slice(0, Math.max(editLen, 0));
  const editBase = commits[Math.max(editLen, 0)]?.hash ?? "";

  function openCherryPickOnto(hash: string) {
    setPickOntoHashes(effectiveSelection(hash));
    setPickOntoBranch(targetBranches[0]?.name ?? "");
  }

  // One shared context menu for the whole list (capture phase, so it records the
  // right-clicked row before the menu opens) instead of a portal per commit.
  // Mirrors the old per-row onContextMenu's selection-collapse, then captures
  // the target; a right-click on blank space hits no row → suppress the menu.
  function handleCommitContextMenu(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest("[data-hash]");
    const hash = rowEl?.getAttribute("data-hash");
    const index = hash ? visibleCommits.findIndex((c) => c.hash === hash) : -1;
    if (index < 0) {
      setMenuTarget(null);
      suppressContextMenu(e);
      return;
    }
    onRowContextMenu(index, visibleCommits[index].hash);
    setMenuTarget({ commit: visibleCommits[index], index });
  }

  // The items for whichever commit was right-clicked — three exclusive variants:
  // search results (position-independent), a multi-selection, or a single commit.
  function renderCommitMenu() {
    if (!menuTarget) return null;
    const { commit, index } = menuTarget;
    if (searchActive) {
      // Search results aren't contiguous recent history, so only the shared set.
      return (
        <CommitContextMenuItems
          hash={commit.hash}
          actions={{
            checkout: doCheckoutCommit,
            revert: doRevertCommit,
            cherryPick: (hash) =>
              doCherryPick(
                hash,
                "Nothing to cherry-pick — already on this branch.",
              ),
            createBranch: (hash) => {
              branchForm.reset({ name: "" });
              setBranchHash(hash);
            },
            createTag: (hash) => {
              tagForm.reset({ name: "" });
              setTagHash(hash);
            },
          }}
        />
      );
    }
    if (selected.has(commit.hash) && selected.size > 1) {
      // Multi-selection: only actions that apply to the whole selection, so
      // nothing silently targets one commit.
      return (
        <>
          <ContextMenuItem
            disabled={!canPickOnto}
            onClick={() => openCherryPickOnto(commit.hash)}
          >
            Cherry-pick {selected.size} commits to branch…
            {pickOntoDisabledHint}
          </ContextMenuItem>
          <ContextMenuItem disabled={!canSquash} onClick={openSquash}>
            Squash {selected.size} commits…
            {!canSquash && squashDisabledHint}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canEditHistory}
            onClick={() => setEditHistoryOpen(true)}
          >
            Edit history…
            {editHistoryHint}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() =>
              copyText(
                effectiveSelection(commit.hash).reverse().join("\n"),
                `${selected.size} SHAs copied`,
              )
            }
          >
            Copy {selected.size} SHAs
          </ContextMenuItem>
        </>
      );
    }
    return (
      <>
        <ContextMenuItem
          disabled={index !== 0}
          onClick={() => requestAmend(commit.hash)}
        >
          Amend commit…
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index !== 0 || !canUndo || undoCommit.isPending}
          onClick={undoLast}
        >
          Undo commit (keep changes)
        </ContextMenuItem>
        <ContextMenuItem
          disabled={index === 0}
          onClick={() => setResetHash(commit.hash)}
        >
          Reset to commit…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => doCheckoutCommit(commit.hash)}>
          Checkout commit
        </ContextMenuItem>
        <ContextMenuItem onClick={() => doRevertCommit(commit.hash)}>
          Revert changes in commit
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            branchForm.reset({ name: "" });
            setBranchHash(commit.hash);
          }}
        >
          Create branch from commit…
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            tagForm.reset({ name: "" });
            setTagHash(commit.hash);
          }}
        >
          Create tag…
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            doCherryPick(
              commit.hash,
              "Nothing to cherry-pick — these changes are already on this branch.",
            )
          }
        >
          Cherry-pick commit
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canPickOnto}
          onClick={() => openCherryPickOnto(commit.hash)}
        >
          Cherry-pick to branch…
          {pickOntoDisabledHint}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canEditHistory}
          onClick={() => setEditHistoryOpen(true)}
        >
          Edit history…
          {editHistoryHint}
        </ContextMenuItem>
        {commit.tags.length > 0 && <ContextMenuSeparator />}
        {commit.tags.map((tag) => (
          <ContextMenuItem
            key={`push:${tag}`}
            onClick={() =>
              pushTag.mutate(tag, {
                onSuccess: () => toast.success(`Pushed tag ${tag} to origin`),
                onError,
              })
            }
          >
            Push tag {tag} to origin
          </ContextMenuItem>
        ))}
        {commit.tags.map((tag) => (
          <ContextMenuItem
            key={`delete:${tag}`}
            onClick={() => {
              setDeleteTagRemote(false);
              setDeleteTagName(tag);
            }}
          >
            Delete tag {tag}…
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => copyText(commit.hash, "SHA copied")}>
          Copy SHA
        </ContextMenuItem>
      </>
    );
  }

  return (
    <>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value);
            // Clearing the box returns to filtering the loaded pages.
            if (!e.target.value.trim()) setSearchMode(false);
          }}
          placeholder={FILTER_PLACEHOLDER}
          className="h-7"
          autoComplete="off"
        />
      </div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            // Native overflow scroll container (not the Base-UI ScrollArea) so
            // the virtualizer's getScrollElement gets the real scrollable node —
            // see docs/list-virtualization.md. Fixed-height flex child so
            // getTotalSize resolves (max-h would leave it unbounded → 0).
            <div
              ref={setScrollEl}
              className="min-h-0 flex-1 overflow-y-auto"
              onKeyDown={onListKeyDown}
              onContextMenuCapture={handleCommitContextMenu}
            />
          }
        >
          {visibleCommits.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-muted-foreground">
                {searchActive
                  ? search.isFetching
                    ? "Searching all history…"
                    : `No commits match "${filterText.trim()}"`
                  : `No loaded commits match "${filterText.trim()}"`}
              </p>
              {!(searchActive && search.isFetching) && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="mt-2 text-muted-foreground"
                  onClick={() => {
                    setFilterText("");
                    setSearchMode(false);
                    filterRef.current?.focus();
                  }}
                >
                  Clear filter
                </Button>
              )}
            </div>
          ) : (
            // Data-gated child: the useVirtualizer call lives here (never in the
            // 900-line parent) so (a) HistoryPanel's body keeps compiling under
            // the React Compiler — useVirtualizer bails its host out — and (b) the
            // virtualizer only ever mounts once there are rows, dodging the
            // first-row measureElement race (docs/list-virtualization.md).
            <CommitList
              scrollEl={scrollEl}
              commits={visibleCommits}
              selected={selected}
              selectedCommitHash={selectedCommitHash}
              unpushedHashes={unpushedHashes}
              upstream={head?.upstreamGone ? null : (head?.upstream ?? null)}
              onRowClick={onRowClick}
              onHoverPrefetch={(hash) =>
                hoverPrefetch(() => prefetchCommit(hash))
              }
            />
          )}
          {searchActive ? (
            <div className="space-y-0.5 px-3 py-2 text-center">
              {search.hasNextPage && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  disabled={search.isFetchingNextPage}
                  onClick={() => search.fetchNextPage()}
                >
                  {search.isFetchingNextPage && (
                    <Spinner data-icon="inline-start" />
                  )}
                  Load more results
                </Button>
              )}
              <div>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => setSearchMode(false)}
                >
                  Back to recent history
                </Button>
              </div>
            </div>
          ) : (
            <>
              {query && (
                <div className="px-3 py-2 text-center">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-primary"
                    onClick={() => setSearchMode(true)}
                  >
                    <MagnifyingGlassIcon data-icon="inline-start" />
                    Search all history for "{filterText.trim()}"
                  </Button>
                </div>
              )}
              {log.hasNextPage && (
                <div className="px-3 py-2 text-center">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    disabled={log.isFetchingNextPage}
                    onClick={() => log.fetchNextPage()}
                  >
                    {log.isFetchingNextPage && (
                      <Spinner data-icon="inline-start" />
                    )}
                    Load more ({commits.length} loaded)
                  </Button>
                </div>
              )}
            </>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-60">
          {renderCommitMenu()}
        </ContextMenuContent>
      </ContextMenu>

      {squashCtx && (
        <SquashDialog
          repoPath={repoPath}
          base={squashCtx.base}
          steps={squashCtx.steps}
          count={squashCtx.count}
          defaultMessage={squashCtx.defaultMessage}
          open
          onOpenChange={(open) => {
            if (!open) setSquashCtx(null);
          }}
          onDone={() => setSelected(new Set())}
        />
      )}

      {editHistoryOpen && (
        <EditHistoryDialog
          repoPath={repoPath}
          base={editBase}
          commits={editCommits}
          open
          onOpenChange={setEditHistoryOpen}
          onDone={() => setSelected(new Set())}
        />
      )}

      <AmendForcePushDialog {...forcePushDialog} />

      <DeleteTagDialog
        repoPath={repoPath}
        name={deleteTagName}
        remote={deleteTagRemote}
        onRemoteChange={setDeleteTagRemote}
        onClose={() => setDeleteTagName(null)}
      />

      <ResetCommitDialog
        repoPath={repoPath}
        hash={resetHash}
        onClose={() => setResetHash(null)}
      />

      <CreateRefFromCommitDialog
        form={branchForm}
        open={branchHash !== null}
        onClose={() => setBranchHash(null)}
        title="Create branch from commit"
        description={`Creates a branch starting at ${shownBranchHash?.slice(0, 7) ?? ""} and switches to it.`}
        fieldLabel="Branch name"
        placeholder="feature/from-commit"
        submitLabel="Create branch"
      />

      <CreateRefFromCommitDialog
        form={tagForm}
        open={tagHash !== null}
        onClose={() => setTagHash(null)}
        title="Create tag"
        description={`Tags commit ${shownTagHash?.slice(0, 7) ?? ""}.`}
        fieldLabel="Tag name"
        placeholder="v1.0.0"
        submitLabel="Create tag"
      />

      <CherryPickOntoDialog
        repoPath={repoPath}
        hashes={pickOntoHashes}
        branch={pickOntoBranch}
        onBranchChange={setPickOntoBranch}
        branches={targetBranches}
        currentBranch={currentBranch}
        onClose={() => setPickOntoHashes(null)}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}

// The virtualized commit rows. Isolated in its own leaf component for two
// reasons (docs/list-virtualization.md): useVirtualizer bails its host
// component out of the React Compiler ("incompatible library"), so keeping it
// here lets HistoryPanel's body — filtering, selection, handlers — keep
// compiling; and it only mounts once `commits` is non-empty, so the virtualizer
// never races measureElement over an empty-then-filled list.
function CommitList({
  scrollEl,
  commits,
  selected,
  selectedCommitHash,
  unpushedHashes,
  upstream,
  onRowClick,
  onHoverPrefetch,
}: {
  scrollEl: HTMLDivElement | null;
  commits: CommitSummary[];
  selected: Set<string>;
  selectedCommitHash: string | null;
  unpushedHashes: Set<string>;
  upstream: string | null;
  onRowClick: (e: React.MouseEvent, index: number, hash: string) => void;
  onHoverPrefetch: (hash: string) => void;
}) {
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollEl,
    // Rows are near-uniform (~52px: two text lines + padding); measureElement
    // corrects any that wrap.
    estimateSize: () => 52,
    overscan: 12,
    // Key by commit hash, not index, so filtering/search swaps keep stable
    // measurements instead of reusing a stale height for a different commit.
    getItemKey: (index) => commits[index].hash,
  });

  // Arrow-key nav moves the selection by index; the target row may be outside
  // the virtualizer's mounted window (offscreen rows unmount), so
  // listKeyboardNav's synchronous data-hash querySelector finds nothing and
  // focus is dropped. On a *changed* selection we scroll the target into view,
  // then re-focus it on the next frame once it has mounted.
  const prevSelectedHash = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer + scrollEl are stable refs; the guard runs only on hash change
  useEffect(() => {
    // Gate on the hash actually CHANGING so list growth (Load more appends to
    // `commits`) never yanks the scroll back to a selected-but-offscreen commit.
    if (selectedCommitHash === prevSelectedHash.current) return;
    prevSelectedHash.current = selectedCommitHash;
    if (!selectedCommitHash) return;
    const idx = commits.findIndex((c) => c.hash === selectedCommitHash);
    if (idx < 0) return;
    virtualizer.scrollToIndex(idx, { align: "auto" });
    // The row mounts after the scroll re-renders; re-focus it next frame so the
    // focus ring + SR position follow the selection. Guard: only when focus is
    // already inside the list, so we never steal it from the filter box.
    const raf = requestAnimationFrame(() => {
      if (!scrollEl?.contains(document.activeElement)) return;
      scrollEl
        .querySelector<HTMLElement>(
          `[data-hash="${CSS.escape(selectedCommitHash)}"]`,
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedCommitHash, commits]);

  return (
    <div
      className="relative w-full"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const commit = commits[vi.index];
        const index = vi.index;
        return (
          <button
            key={vi.key}
            type="button"
            data-index={index}
            ref={virtualizer.measureElement}
            data-hash={commit.hash}
            className={cn(
              "absolute top-0 left-0 flex w-full items-start gap-2 border-b px-3 py-2 text-left",
              selected.has(commit.hash) ||
                (selected.size === 0 && selectedCommitHash === commit.hash)
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/60",
            )}
            style={{ transform: `translateY(${vi.start}px)` }}
            onClick={(e) => onRowClick(e, index, commit.hash)}
            onMouseEnter={() => onHoverPrefetch(commit.hash)}
          >
            <CommitAuthorAvatar
              name={commit.author}
              email={commit.authorEmail}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <span className="min-w-0 truncate" title={commit.subject}>
                  {commit.subject}
                </span>
                {commit.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="flex max-w-24 shrink-0 items-center gap-0.5 border px-1 py-px text-[10px] font-normal text-muted-foreground"
                    title={`tag: ${tag}`}
                  >
                    <TagIcon className="size-2.5 shrink-0" />
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
                {commit.tags.length > 2 && (
                  <span
                    className="shrink-0 text-[10px] font-normal text-muted-foreground"
                    title={commit.tags.join(", ")}
                  >
                    +{commit.tags.length - 2}
                  </span>
                )}
                {unpushedHashes.has(commit.hash) && (
                  <span
                    className="ml-auto flex shrink-0 items-center text-muted-foreground"
                    title={
                      upstream
                        ? `Not pushed yet — ahead of ${upstream}`
                        : "Not pushed yet"
                    }
                    aria-label="Not pushed yet"
                  >
                    <ArrowUpIcon className="size-3" weight="bold" />
                  </span>
                )}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">{commit.author}</span>
                <span>•</span>
                <span className="shrink-0">
                  <RelativeTime date={commit.date} />
                </span>
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
