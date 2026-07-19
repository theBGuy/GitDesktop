import { Popover } from "@base-ui/react/popover";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  CloudArrowDownIcon,
  CloudSlashIcon,
  CloudXIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
  isDeletionBlocked,
  isMergeMethodAllowed,
  requiresPullRequest,
} from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import {
  forgeFeatureReady,
  useBranchDivergence,
  useBranches,
  useCheckoutBranch,
  useCheckoutRemoteBranch,
  useDefaultBranch,
  useDeleteBranch,
  useDeleteRemoteBranch,
  useDiscardAll,
  useForgeStatus,
  useMergeBranch,
  usePrList,
  usePush,
  useRebaseBranch,
  useRebaseOnto,
  useRemoteBranches,
  useRemotes,
  useRepoStatus,
  useSetBranchArchived,
  useStashAll,
  useStashCount,
  useStashPop,
  useUpdateBranchFrom,
  useUserWorktrees,
} from "@/lib/git/queries";
import type { Branch, RemoteBranch } from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useLocalPrs } from "@/lib/pulls/queries";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { type SelectedPr, useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  BranchMergePickerDialog,
  type MergeRunOptions,
  type PickerMode,
} from "./BranchMergePickerDialog";
import { CleanupBranchesDialog } from "./CleanupBranchesDialog";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { OperationHistoryDialog } from "./OperationHistoryDialog";
import { PromoteWorktreeDialog } from "./PromoteWorktreeDialog";
import { RebaseOntoDialog } from "./RebaseOntoDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { StashesDialog } from "./StashesDialog";
import { SwitchWithChangesDialog } from "./SwitchWithChangesDialog";
import { useOpenWorktree } from "./useOpenRepoByPath";

/** Lower-cased, forward-slashed path for cross-source comparison — git emits
 *  "/", the app stores "\" on Windows. */
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Last path segment (folder name), tolerating either separator. */
const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;

type PrState = "open" | "draft" | "merged" | "closed";

interface BranchPr {
  state: PrState;
  /** "#123" for a remote PR, "local" for a local-only one. */
  label: string;
  select: SelectedPr;
}

// When a branch has several PRs, the most actionable state wins.
const PR_RANK: Record<PrState, number> = {
  open: 3,
  draft: 3,
  merged: 2,
  closed: 1,
};

// GitHub's PR-state palette, via the app's semantic color tokens.
const PR_TONE: Record<PrState, string> = {
  open: "text-success",
  draft: "text-muted-foreground",
  merged: "text-merged",
  closed: "text-destructive",
};

const PR_STATE_LABEL: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

function MenuRow({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function BranchSwitcher({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const branches = useBranches(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const stashCount = useStashCount(repoPath);
  const checkout = useCheckoutBranch(repoPath);
  const checkoutRemote = useCheckoutRemoteBranch(repoPath);
  const deleteBranch = useDeleteBranch(repoPath);
  const deleteRemoteBranch = useDeleteRemoteBranch(repoPath);
  const discardAll = useDiscardAll(repoPath);
  const stashAll = useStashAll(repoPath);
  const stashPop = useStashPop(repoPath);
  const mergeBranch = useMergeBranch(repoPath);
  const rebaseBranch = useRebaseBranch(repoPath);
  const rebaseOnto = useRebaseOnto(repoPath);
  const updateBranchFrom = useUpdateBranchFrom(repoPath);
  const push = usePush(repoPath);
  const remotes = useRemotes(repoPath);
  const setBranchArchived = useSetBranchArchived(repoPath);
  const openWorktree = useOpenWorktree();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  const amendingHash = useUiStore((s) => s.amendingHash);
  const openSettings = useUiStore((s) => s.openSettings);
  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();

  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Remote-only branches show expanded by default (the point is to see them);
  // archived shows collapsed (it's intentionally-hidden clutter).
  const [showRemote, setShowRemote] = useState(true);
  const [branchFilter, setBranchFilter] = useState("");
  // The branch row the keyboard nav last landed on (drives arrow-key movement).
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // The worktree a branch row offers to remove (resolved from `userWorktrees`).
  const [removeWorktreeTarget, setRemoveWorktreeTarget] =
    useState<UserWorktree | null>(null);
  // The remote-only branch pending a server-side delete confirm.
  const [remoteDeleteTarget, setRemoteDeleteTarget] = useState<{
    remote: string;
    name: string;
  } | null>(null);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [stashAllOpen, setStashAllOpen] = useState(false);
  const [stashPopOpen, setStashPopOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  // Which view the Stashes dialog opens to — "recoverable" for "Recover lost
  // work…" and its palette action, "stashes" otherwise.
  const [stashesView, setStashesView] = useState<"stashes" | "recoverable">(
    "stashes",
  );
  const [opHistoryOpen, setOpHistoryOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [rebaseOntoOpen, setRebaseOntoOpen] = useState(false);
  // The pending switch target. `remote` is set only for remote-only rows, which
  // check out via `--track <remote>/<name>` (honoring the row's promised remote
  // + dodging multi-remote DWIM ambiguity); local switches leave it null.
  const [switchTarget, setSwitchTarget] = useState<{
    name: string;
    remote: string | null;
  } | null>(null);
  // A branch checked out in another worktree, awaiting confirm to open it.
  const [worktreeSwitchTarget, setWorktreeSwitchTarget] = useState<{
    name: string;
    path: string;
  } | null>(null);
  // The worktree pending a "Promote to main workspace" confirm — set by the
  // palette action (the Worktrees dialog hosts its own promote flow).
  const [promoteTarget, setPromoteTarget] = useState<UserWorktree | null>(null);

  const head = status.data?.branch;
  const currentName = head?.name ?? null;
  const currentLabel = head?.detached
    ? `detached @ ${head.oid?.slice(0, 7) ?? "?"}`
    : (currentName ?? "…");
  // Agent-session branches (`gd/session/*`) are app-internal — never list or act
  // on them in the switcher. Critically, a *kept* session's worktree is removed
  // but its branch persists, so without this filter its branch would show here
  // with Delete enabled, and `git branch -D` would destroy a branch the sessions
  // registry still needs to Resume. (Worktrees-side exclusion doesn't cover the
  // branch list, which comes straight from `git for-each-ref`.)
  const allBranches = (branches.data ?? []).filter(
    (b) => !b.name.startsWith("gd/session/"),
  );
  // Archived branches are hidden from the list and the merge picker.
  const otherBranches = allBranches.filter((b) => !b.isCurrent && !b.archived);
  const defaultName = defaultBranch.data ?? null;
  // Merge-into-current is gated by the current branch's protection: a
  // "require pull request" rule blocks all direct merges, and a merge-method
  // restriction blocks the disallowed methods.
  const lockCurrent = currentName
    ? requiresPullRequest(rulesConfig, currentName)
    : false;
  const canMergeIntoCurrent =
    !lockCurrent &&
    (currentName
      ? isMergeMethodAllowed(rulesConfig, currentName, "merge")
      : true);
  const canSquashIntoCurrent =
    !lockCurrent &&
    (currentName
      ? isMergeMethodAllowed(rulesConfig, currentName, "squash")
      : true);
  // Ahead/behind vs. the default branch, fetched only while the menu is open.
  const divergence = useBranchDivergence(repoPath, defaultName, open);
  const divByName = useMemo(
    () => new Map((divergence.data ?? []).map((d) => [d.name, d] as const)),
    [divergence.data],
  );

  // Per-branch PR badge. Remote PRs (open + closed, the latter carrying merged)
  // and local PRs, fetched only while the menu is open and the repo has a
  // Per-branch PR/MR popovers — the list reads work for GitHub and GitLab alike.
  const gh = useForgeStatus(repoPath);
  const canGh = forgeFeatureReady(gh.data, "pullRequests");
  // Origin lens: the branch popover lists the FORK's own branch PRs; the
  // fork/upstream lens is a Pulls/Issues-tab affordance.
  const openPrs = usePrList(
    repoPath,
    canGh && open,
    "open",
    undefined,
    "origin",
  );
  const closedPrs = usePrList(
    repoPath,
    canGh && open,
    "closed",
    undefined,
    "origin",
  );
  const localPrs = useLocalPrs(repoPath);
  const selectPr = useUiStore((s) => s.selectPr);
  const setLens = useSetRepoLens(repoPath);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  const prByBranch = useMemo(() => {
    const map = new Map<string, BranchPr>();
    const consider = (branchName: string, cand: BranchPr) => {
      const cur = map.get(branchName);
      if (!cur || PR_RANK[cand.state] > PR_RANK[cur.state]) {
        map.set(branchName, cand);
      }
    };
    // Remote PRs first, so they win ties against a local PR of equal state.
    for (const pr of [...(openPrs.data ?? []), ...(closedPrs.data ?? [])]) {
      const state: PrState =
        pr.isDraft && pr.state === "OPEN"
          ? "draft"
          : pr.state === "MERGED"
            ? "merged"
            : pr.state === "CLOSED"
              ? "closed"
              : "open";
      consider(pr.headRefName, {
        state,
        label: `#${pr.number}`,
        select: { kind: "remote", id: String(pr.number) },
      });
    }
    for (const pr of localPrs.data ?? []) {
      const state: PrState =
        pr.status === "merged"
          ? "merged"
          : pr.status === "closed"
            ? "closed"
            : "open";
      consider(pr.head, {
        state,
        label: "local",
        select: { kind: "local", id: pr.id },
      });
    }
    return map;
  }, [openPrs.data, closedPrs.data, localPrs.data]);

  const openPr = (select: SelectedPr) => {
    // A remote PR here is a fork (origin) PR — force the origin lens (which also
    // clears any stale upstream remote selection) before navigating to it.
    if (select.kind === "remote") setLens("origin");
    selectPr(select);
    setRepoTab("pulls");
    setOpen(false);
  };

  // Branches checked out in *another* worktree → that worktree's path. Git
  // forbids the same branch in two worktrees, so these can't be checked out
  // here; the row offers to open the worktree instead. The active repo's own
  // branch is excluded (it's the one you're on). Fetched only while open.
  const userWorktrees = useUserWorktrees(repoPath, open);
  const activeNorm = normPath(repoPath);
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of userWorktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, w.path);
    }
    return map;
  }, [userWorktrees.data, activeNorm]);
  // Cross-worktree navigation (fetched only while open): the main workspace, the
  // other worktrees you can jump to, and whether you're currently in a linked
  // (non-main) worktree — where a branch checkout lands here, not in main.
  const worktreeList = userWorktrees.data ?? [];
  const currentWorktree = worktreeList.find(
    (w) => normPath(w.path) === activeNorm,
  );
  const mainWorktree = worktreeList.find((w) => w.isMain);
  const otherWorktrees = worktreeList.filter(
    (w) => normPath(w.path) !== activeNorm,
  );
  const inLinkedWorktree = Boolean(currentWorktree && !currentWorktree.isMain);
  const currentWorktreeName = currentWorktree
    ? baseName(currentWorktree.path)
    : "";
  // Default branch pinned on top, then the rest by most recently committed.
  // Memoized: the compiler won't hoist the `.sort()` copy or the filter
  // allocations, and these recompute on every filter keystroke otherwise.
  const sortedBranches = useMemo(
    () =>
      [...allBranches].sort((a, b) => {
        if (a.name === defaultName) return -1;
        if (b.name === defaultName) return 1;
        return b.lastCommitDate.localeCompare(a.lastCommitDate);
      }),
    [allBranches, defaultName],
  );
  const bq = branchFilter.trim().toLowerCase();
  const visibleBranches = useMemo(
    () =>
      sortedBranches.filter(
        (b) => !b.archived && (!bq || b.name.toLowerCase().includes(bq)),
      ),
    [sortedBranches, bq],
  );
  const archivedBranches = useMemo(
    () =>
      sortedBranches.filter(
        (b) => b.archived && (!bq || b.name.toLowerCase().includes(bq)),
      ),
    [sortedBranches, bq],
  );
  // Branches that live on a remote but aren't checked out locally yet — fetched
  // only while the menu is open. Drop ones already represented by a local branch
  // (its row already shows ahead/behind + PR) and the internal session branches;
  // dedupe a branch that exists on multiple remotes to one row.
  const remoteBranchesQuery = useRemoteBranches(repoPath, open);
  const localNames = useMemo(
    () => new Set(allBranches.map((b) => b.name)),
    [allBranches],
  );
  const remoteOnly = useMemo(() => {
    const seen = new Set<string>();
    return (remoteBranchesQuery.data ?? [])
      .filter(
        (b) =>
          !b.name.startsWith("gd/session/") &&
          !localNames.has(b.name) &&
          (!bq || b.name.toLowerCase().includes(bq)),
      )
      .filter((b) => (seen.has(b.name) ? false : (seen.add(b.name), true)))
      .sort((a, b) => b.lastCommitDate.localeCompare(a.lastCommitDate));
  }, [remoteBranchesQuery.data, localNames, bq]);
  // Only label rows with their remote when there's more than one to disambiguate.
  const multipleRemotes = useMemo(
    () =>
      new Set((remoteBranchesQuery.data ?? []).map((b) => b.remote)).size > 1,
    [remoteBranchesQuery.data],
  );
  // Arrow-key navigation over the visible rows (+ archived when expanded) so
  // keyboard users can move through branches instead of Tabbing each one. Enter
  // on the focused row checks it out via the row button's native click.
  const navBranches: { name: string }[] = [
    ...visibleBranches,
    ...(showArchived ? archivedBranches : []),
    ...(showRemote ? remoteOnly : []),
    // The Worktrees section is a selectable list too — key its rows by path so
    // arrow nav flows from the branch rows straight into it (each row carries a
    // matching `data-row`). Paths use forward slashes, safe as a data-row value.
    ...otherWorktrees.map((w) => ({ name: w.path })),
  ];
  const onBranchKeyDown = listKeyboardNav({
    items: navBranches,
    activeIndex: navBranches.findIndex((b) => b.name === activeBranch),
    onActivate: (b) => setActiveBranch(b.name),
    rowKey: (b) => b.name,
  });
  const stashes = stashCount.data ?? 0;
  const hasChanges = (status.data?.entries.length ?? 0) > 0;
  // Naming a branch from changes needs a commit to diff against; an unborn HEAD
  // (no commits) has nothing to compare the working tree to.
  const headExists = Boolean(head?.oid);
  // You can't amend across branches: amend mode targets a specific commit on
  // this branch, so switching would strand the in-progress amend and leave its
  // banner up. Lock the switcher until the user finishes or stops amending.
  const amending = amendingHash !== null;
  // The repo's configured remotes — ground truth for resolving a branch's
  // upstream remote and for the per-remote Publish choices.
  const remoteNames = remotes.data ?? [];

  const onError = (e: unknown) => toastError(e);

  function setArchived(name: string, archived: boolean) {
    setBranchArchived.mutate(
      { name, archived },
      {
        onSuccess: () =>
          toast.success(archived ? `Archived ${name}` : `Unarchived ${name}`),
        onError,
      },
    );
  }

  // Dispatch the actual checkout — remote-only targets track a specific remote,
  // local targets use plain switch. Both share the guards in `switchTo`.
  function runCheckout(
    target: { name: string; remote: string | null },
    opts?: { onError?: (e: unknown) => void },
  ) {
    if (target.remote) {
      checkoutRemote.mutate({ remote: target.remote, name: target.name }, opts);
    } else {
      checkout.mutate(target.name, opts);
    }
  }

  async function runCheckoutAsync(target: {
    name: string;
    remote: string | null;
  }) {
    if (target.remote) {
      await checkoutRemote.mutateAsync({
        remote: target.remote,
        name: target.name,
      });
    } else {
      await checkout.mutateAsync(target.name);
    }
  }

  function switchTo(name: string, remote: string | null = null) {
    if (amending) return; // guarded by the disabled trigger; belt-and-suspenders
    setOpen(false);
    // A branch that's checked out in another worktree can't be checked out here
    // (git forbids it); offer to open that worktree instead of erroring.
    const wtPath = worktreeByBranch.get(name);
    if (wtPath) {
      setWorktreeSwitchTarget({ name, path: wtPath });
      return;
    }
    // with work in progress, let the user choose to bring or stash it
    if (hasChanges) {
      setSwitchTarget({ name, remote });
      return;
    }
    runCheckout({ name, remote }, { onError });
  }

  function bringAndSwitch() {
    if (!switchTarget) return;
    const target = switchTarget;
    setSwitchTarget(null);
    runCheckout(target, { onError });
  }

  async function stashAndSwitch() {
    if (!switchTarget) return;
    const target = switchTarget;
    setSwitchTarget(null);
    try {
      await stashAll.mutateAsync(undefined);
      await runCheckoutAsync(target);
      toast.success(
        `Stashed changes and switched to ${target.name} — "Pop latest stash" restores them`,
      );
    } catch (e) {
      onError(e);
    }
  }

  // The dialog seeds its own form field on open; the switcher only flags which
  // branch is being renamed.
  function openRename(branch: string) {
    setOpen(false);
    setRenameTarget(branch);
  }

  async function doDelete() {
    if (!deleteTarget) return;
    // Belt-and-suspenders: the menu items are already disabled for protected
    // branches, but guard here too in case a rule changed under an open dialog.
    if (isDeletionBlocked(rulesConfig, deleteTarget)) {
      toast.error(
        `${deleteTarget} is protected from deletion by a branch rule`,
      );
      setDeleteTarget(null);
      return;
    }
    try {
      // git refuses to delete the checked-out branch: move off it first — onto a
      // branch that isn't already occupied by another worktree (checking out an
      // occupied branch fails too, which is what stranded the delete before).
      if (deleteTarget === currentName) {
        // Fetch occupancy FRESH: the cached `worktreeByBranch` is gated on the
        // popover being open, but a delete can fire from the `delete-branch`
        // hotkey that never opened it — leaving the map empty and the guard moot.
        let occupied: Set<string>;
        try {
          const wts = await listUserWorktrees(repoPath);
          occupied = new Set(
            wts
              .filter(
                (w) => w.branch && normPath(w.path) !== normPath(repoPath),
              )
              .map((w) => w.branch),
          );
        } catch {
          occupied = new Set(worktreeByBranch.keys());
        }
        const free = (b: string | null | undefined): b is string =>
          Boolean(b) && b !== deleteTarget && !occupied.has(b as string);
        const fallback = free(defaultName)
          ? defaultName
          : otherBranches.find((b) => free(b.name))?.name;
        if (!fallback) {
          toast.error(
            "Can't switch off this branch — every other branch is checked out in a worktree.",
          );
          setDeleteTarget(null);
          return;
        }
        await checkout.mutateAsync(fallback);
      }
      await deleteBranch.mutateAsync(deleteTarget);
      toast.success(`Deleted ${deleteTarget}`);
    } catch (e) {
      onError(e);
    } finally {
      setDeleteTarget(null);
    }
  }

  // The picker dialog seeds its own branch + options on open; the switcher only
  // flags which mode is active.
  function openPicker(mode: PickerMode) {
    setOpen(false);
    setPickerMode(mode);
  }

  // The dialog collects the branch + options; the switcher owns the mutations
  // (they feed `busy`) and dispatches them here after closing the picker.
  function runPicker(
    mode: PickerMode,
    branch: string,
    options: MergeRunOptions,
  ) {
    setPickerMode(null);
    if (mode === "rebase") {
      rebaseBranch.mutate(branch, {
        onSuccess: () => toast.success(`Rebased onto ${branch}`),
        onError,
      });
    } else {
      mergeBranch.mutate(
        {
          branch,
          squash: mode === "squash",
          // Options apply to a regular merge only, not squash.
          noFf: mode === "merge" && options.noFf,
          strategy: mode === "merge" ? options.strategy : "none",
        },
        {
          onSuccess: () =>
            toast.success(
              mode === "squash"
                ? `Squashed ${branch} — changes are staged, review and commit`
                : `Merged ${branch}`,
            ),
          onError,
        },
      );
    }
  }

  function openCreate() {
    setOpen(false);
    setCreateOpen(true);
  }

  function openRebaseOnto() {
    setOpen(false);
    setRebaseOntoOpen(true);
  }

  // The dialog collects the two branches; the switcher owns the mutation (it
  // feeds `busy`). Conflicts leave the rebase in progress for the conflict
  // banner, exactly like the plain rebase above.
  function runRebaseOnto(newBase: string, oldBase: string) {
    setRebaseOntoOpen(false);
    rebaseOnto.mutate(
      { newBase, oldBase },
      {
        onSuccess: () => toast.success(`Rebased onto ${newBase}`),
        onError,
      },
    );
  }

  // Pull the latest from the default branch into `target` without switching to
  // it (unless it's already current): fast-forwards when possible, otherwise
  // merges via a throwaway worktree so the working tree — and its watchers —
  // stay put. A conflicting merge aborts and reports rather than switching.
  function doUpdateFromDefault(target: string) {
    if (!defaultName || target === defaultName) return;
    setOpen(false);
    updateBranchFrom.mutate(
      { branch: target, base: defaultName },
      {
        onSuccess: (status) =>
          toast.success(
            status === "up-to-date"
              ? `${target} is already up to date with ${defaultName}`
              : `Updated ${target} from ${defaultName}`,
          ),
        onError,
      },
    );
  }

  // Pull `target`'s own upstream (e.g. `origin/master`) into it without checking
  // it out — the "just merged a PR, bring master current before I switch back"
  // flow. Merges in place when `target` is current, fast-forwards otherwise.
  function doUpdateFromUpstream(target: string, base: string) {
    setOpen(false);
    updateBranchFrom.mutate(
      { branch: target, base },
      {
        onSuccess: (status) =>
          toast.success(
            status === "up-to-date"
              ? `${target} is already up to date with ${base}`
              : `Updated ${target} from ${base}`,
          ),
        onError,
      },
    );
  }

  // Push a branch's ref without checking it out — the outbound counterpart of
  // doUpdateFromUpstream. Whether this publishes (-u) or plain pushes is decided
  // backend-side from the branch's tracking state. The publish arms pass an
  // explicit `remote` (the chosen destination); a tracked push passes none and
  // the backend resolves to the branch's own upstream remote.
  function doPushBranch(branch: Branch, remote?: string) {
    const publishing = !branch.upstream || branch.upstreamGone;
    setOpen(false);
    push.mutate(
      { setUpstream: false, branch: branch.name, remote },
      {
        onSuccess: () =>
          toast.success(
            publishing
              ? `Published ${branch.name} to ${remote ?? "origin"}`
              : `Pushed ${branch.name} to ${branch.upstream}`,
          ),
        onError,
      },
    );
  }

  const busy =
    checkout.isPending ||
    checkoutRemote.isPending ||
    mergeBranch.isPending ||
    rebaseBranch.isPending ||
    rebaseOnto.isPending ||
    push.isPending ||
    updateBranchFrom.isPending;

  // Hotkey handlers reuse the menu's own flows, so every gate (clean tree,
  // stash count, picker availability) and confirm dialog applies equally.
  useHotkeyAction("show-branches", () => setOpen(true), !amending);
  useHotkeyAction("new-branch", openCreate);
  useHotkeyAction(
    "rename-branch",
    () => currentName && openRename(currentName),
    Boolean(currentName),
  );
  useHotkeyAction(
    "delete-branch",
    () => {
      setOpen(false);
      if (currentName) setDeleteTarget(currentName);
    },
    Boolean(currentName && !isDeletionBlocked(rulesConfig, currentName)),
  );
  useHotkeyAction("cleanup-branches", () => {
    setOpen(false);
    setCleanupOpen(true);
  });
  useHotkeyAction(
    "update-from-default",
    () => currentName && doUpdateFromDefault(currentName),
    Boolean(defaultName && defaultName !== currentName && !busy),
  );
  const defaultBranchRow = allBranches.find((b) => b.name === defaultName);
  useHotkeyAction(
    "update-default-from-upstream",
    () =>
      defaultBranchRow?.upstream &&
      !defaultBranchRow.upstreamGone &&
      doUpdateFromUpstream(defaultBranchRow.name, defaultBranchRow.upstream),
    Boolean(defaultBranchRow?.upstream) &&
      !defaultBranchRow?.upstreamGone &&
      !busy,
  );
  useHotkeyAction(
    "merge-into-current",
    () => openPicker("merge"),
    otherBranches.length > 0 && canMergeIntoCurrent,
  );
  useHotkeyAction(
    "squash-merge-into-current",
    () => openPicker("squash"),
    otherBranches.length > 0 && canSquashIntoCurrent,
  );
  useHotkeyAction(
    "rebase-current",
    () => openPicker("rebase"),
    otherBranches.length > 0 && !lockCurrent,
  );
  useHotkeyAction(
    "rebase-onto-new-base",
    openRebaseOnto,
    Boolean(currentName) && otherBranches.length >= 2 && !lockCurrent && !busy,
  );
  useHotkeyAction("stash-all", () => setStashAllOpen(true), hasChanges);
  useHotkeyAction("pop-stash", () => setStashPopOpen(true), stashes > 0);
  useHotkeyAction(
    "view-stashes",
    () => {
      setStashesView("stashes");
      setStashesOpen(true);
    },
    stashes > 0,
  );
  // Always enabled — orphaned work commonly exists even with zero live stashes.
  useHotkeyAction("recover-lost-work", () => {
    setStashesView("recoverable");
    setStashesOpen(true);
  });
  useHotkeyAction("operation-history", () => setOpHistoryOpen(true));
  useHotkeyAction("discard-all", () => setDiscardAllOpen(true), hasChanges);
  // Cross-worktree navigation (palette-only). They can fire while the popover is
  // closed, so they can't rely on the open-gated `userWorktrees` cache — fetch
  // the worktree list fresh, like the delete-branch off-switch does.
  useHotkeyAction("open-main-workspace", async () => {
    setOpen(false);
    try {
      const wts = await listUserWorktrees(repoPath);
      const main = wts.find((w) => w.isMain);
      if (!main) {
        toast.error("Couldn't find the main workspace for this repository.");
        return;
      }
      if (normPath(main.path) === normPath(repoPath)) {
        toast.info("Already in the main workspace.");
        return;
      }
      openWorktree(main.path);
    } catch (e) {
      toastError(e);
    }
  });
  useHotkeyAction("promote-worktree-to-main", async () => {
    setOpen(false);
    try {
      const wts = await listUserWorktrees(repoPath);
      const here = wts.find((w) => normPath(w.path) === normPath(repoPath));
      if (!here || here.isMain) {
        toast.info(
          "Open a linked worktree to promote its branch to the main workspace.",
        );
        return;
      }
      if (here.isDetached || !here.branch) {
        toast.info("This worktree has no branch to promote.");
        return;
      }
      if (here.isLocked) {
        toast.info("This worktree is locked — unlock it before promoting.");
        return;
      }
      setPromoteTarget(here);
    } catch (e) {
      toastError(e);
    }
  });

  // Shared by the visible list and the Archived section.
  const renderBranchRow = (branch: Branch) => {
    const div = divByName.get(branch.name);
    const canUpdate = Boolean(defaultName) && branch.name !== defaultName;
    const deletionBlocked = isDeletionBlocked(rulesConfig, branch.name);
    const inWorktree = worktreeByBranch.has(branch.name);
    // Outbound sync gating. `pushable` = tracked on a KNOWN remote and ahead →
    // offer a plain push to that remote (disabled with "(diverged)" when also
    // behind); the backend resolves to the branch's own upstream remote.
    // `publishable` = untracked or gone AND at least one remote exists → offer
    // Publish (one item per remote on a multi-remote repo). Hidden (not disabled)
    // when in-sync, or tracked on a remote that no longer exists.
    const upstreamRemote =
      branch.upstream &&
      !branch.upstreamGone &&
      branch.upstreamRemote &&
      remoteNames.includes(branch.upstreamRemote)
        ? branch.upstreamRemote
        : null;
    const pushable = Boolean(upstreamRemote) && branch.upstreamAhead > 0;
    const publishable =
      (!branch.upstream || branch.upstreamGone) && remoteNames.length > 0;
    // Publish destinations: origin first, then the rest alphabetical.
    const publishRemotes = publishable
      ? [...remoteNames].sort((a, b) =>
          a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b),
        )
      : [];
    return (
      <ContextMenu key={branch.name}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              data-row={branch.name}
              className="flex w-full flex-col gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
              onClick={() => {
                if (!branch.isCurrent) switchTo(branch.name);
              }}
            >
              {/* Line 1: branch name (+ default tag) with the current-branch
                  check pinned to the right edge. */}
              <span className="flex w-full items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate"
                  // Only expose the full name as a tooltip when it's actually
                  // clipped — measured just-in-time on hover, so no per-row refs.
                  onMouseEnter={(e) => {
                    const el = e.currentTarget;
                    el.title =
                      el.scrollWidth > el.clientWidth ? branch.name : "";
                  }}
                >
                  {branch.name}
                  {branch.name === defaultName && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      default
                    </span>
                  )}
                </span>
                {branch.isCurrent && (
                  <CheckIcon className="size-3.5 shrink-0" />
                )}
              </span>
              {/* Line 2: PR badge · worktree · sync · divergence, then the
                  relative time pushed to the far right. Always renders (the
                  time is always present). */}
              <span className="flex w-full items-center gap-2">
                {(() => {
                  const pr = prByBranch.get(branch.name);
                  if (!pr) return null;
                  const isLocal = pr.select.kind === "local";
                  return (
                    <span
                      role="button"
                      tabIndex={0}
                      title={
                        isLocal
                          ? `${PR_STATE_LABEL[pr.state]} local pull request — open in Pull Requests`
                          : `${PR_STATE_LABEL[pr.state]} pull request ${pr.label} — open in Pull Requests`
                      }
                      className={cn(
                        "flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] tabular-nums hover:underline",
                        PR_TONE[pr.state],
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPr(pr.select);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          openPr(pr.select);
                        }
                      }}
                    >
                      <GitPullRequestIcon className="size-3" weight="bold" />
                      {pr.label}
                    </span>
                  );
                })()}
                {inWorktree && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
                    title={`Checked out in another worktree (${worktreeByBranch.get(
                      branch.name,
                    )}) — open it instead of switching`}
                  >
                    <TreeStructureIcon className="size-3" weight="bold" />
                    worktree
                  </span>
                )}
                {/* Two distinct indicators per row: (1) the sync indicator
                    below shows the branch's OWN upstream push/pull state in the
                    arrow vocabulary (matching the header's Push/Pull badges), so
                    "Update from {upstream}" / "Push to {upstream}" stay
                    discoverable on every branch; (2) the divergence indicator
                    further down shows how far the branch has drifted from the
                    DEFAULT branch, rendered as `+N −M {default}` text so it can't
                    be mistaken for unpushed work. Sync is skipped entirely on a
                    remoteless repo (there's no push story). */}
                {remoteNames.length > 0 &&
                  (() => {
                    // A branch tracking a remote that's since been removed (while
                    // other remotes remain) offers neither Push nor Publish in the
                    // context menu — arrows here would imply a push/pull action the
                    // menu can't honor, so render the muted local-only marker with a
                    // NO-action title. `upstreamRemote` is null for a branch tracking
                    // a LOCAL upstream (git's `%(upstream:remotename)` is empty →
                    // None on the Rust side); the `branch.upstreamRemote &&` conjunct
                    // keeps such a branch OUT of this case so its truthful vs-local
                    // arrows still show below.
                    if (
                      branch.upstream &&
                      !branch.upstreamGone &&
                      branch.upstreamRemote &&
                      !remoteNames.includes(branch.upstreamRemote)
                    ) {
                      const label = `Tracks ${branch.upstream}, but that remote is no longer configured.`;
                      return (
                        <span
                          role="img"
                          aria-label={label}
                          className="flex shrink-0 items-center text-muted-foreground"
                          title={label}
                        >
                          <CloudSlashIcon className="size-3" />
                        </span>
                      );
                    }
                    if (branch.upstream && !branch.upstreamGone) {
                      if (
                        branch.upstreamAhead === 0 &&
                        branch.upstreamBehind === 0
                      ) {
                        // In sync with the upstream — silence means synced.
                        return null;
                      }
                      const parts: string[] = [];
                      if (branch.upstreamAhead > 0)
                        parts.push(`${branch.upstreamAhead} to push`);
                      if (branch.upstreamBehind > 0)
                        parts.push(`${branch.upstreamBehind} to pull`);
                      const label = `${parts.join(", ")} — vs ${branch.upstream}`;
                      return (
                        <span
                          // No text color: inherits the row foreground (a step
                          // stronger than the muted divergence) and follows the
                          // hover accent-foreground automatically. The arrow SVGs are
                          // aria-hidden, so the span carries the name for readers.
                          aria-label={label}
                          className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums"
                          title={label}
                        >
                          {branch.upstreamAhead > 0 && (
                            <span className="flex items-center gap-0.5">
                              <ArrowUpIcon className="size-3" weight="bold" />
                              {branch.upstreamAhead}
                            </span>
                          )}
                          {branch.upstreamBehind > 0 && (
                            <span className="flex items-center gap-0.5">
                              <ArrowDownIcon className="size-3" weight="bold" />
                              {branch.upstreamBehind}
                            </span>
                          )}
                        </span>
                      );
                    }
                    if (branch.upstreamGone) {
                      const label = `Upstream ${branch.upstream} was deleted on the remote — likely merged. Right-click to publish again or delete.`;
                      return (
                        <span
                          role="img"
                          aria-label={label}
                          className="flex shrink-0 items-center text-muted-foreground"
                          title={label}
                        >
                          <CloudXIcon className="size-3" />
                        </span>
                      );
                    }
                    // !branch.upstream
                    return (
                      <span
                        role="img"
                        aria-label="Local only — never published. Right-click to publish."
                        className="flex shrink-0 items-center text-muted-foreground"
                        title="Local only — never published. Right-click to publish."
                      >
                        <CloudSlashIcon className="size-3" />
                      </span>
                    );
                  })()}
                {div &&
                  (div.ahead > 0 || div.behind > 0) &&
                  (() => {
                    const parts: string[] = [];
                    if (div.ahead > 0)
                      parts.push(
                        `${div.ahead} commit${div.ahead === 1 ? "" : "s"} ahead of ${defaultName}`,
                      );
                    if (div.behind > 0)
                      parts.push(
                        `${div.behind} commit${div.behind === 1 ? "" : "s"} behind`,
                      );
                    const label = parts.join(", ");
                    return (
                      <span
                        aria-label={label}
                        className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
                        title={label}
                      >
                        {div.ahead > 0 && <span>+{div.ahead}</span>}
                        {div.behind > 0 && <span>{`−${div.behind}`}</span>}
                        <span>{defaultName}</span>
                      </span>
                    );
                  })()}
                {branch.lastCommitDate && (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatRelativeTime(branch.lastCommitDate)}
                  </span>
                )}
              </span>
            </button>
          }
        />
        <ContextMenuContent className="min-w-48">
          {(canUpdate ||
            (branch.upstream && branch.upstreamBehind > 0) ||
            pushable ||
            publishable) && (
            <>
              {canUpdate && (
                <ContextMenuItem
                  disabled={busy}
                  onClick={() => doUpdateFromDefault(branch.name)}
                >
                  Update from {defaultName}
                </ContextMenuItem>
              )}
              {/* Pull the branch's own upstream in without switching — the star
                  use case is the default branch after a PR merged upstream. */}
              {branch.upstream && branch.upstreamBehind > 0 && (
                <ContextMenuItem
                  disabled={busy}
                  onClick={() =>
                    branch.upstream &&
                    doUpdateFromUpstream(branch.name, branch.upstream)
                  }
                >
                  Update from {branch.upstream}
                </ContextMenuItem>
              )}
              {/* Sync-out below sync-in. Push a branch's ref to origin without
                  checking it out — works even when the branch is checked out in
                  another worktree, since a push touches refs, never a working
                  tree (hence deliberately NO inWorktree gate). Diverged branches
                  push disabled with the reason in the label; the "Update from"
                  item above is their remedy. */}
              {pushable && (
                <ContextMenuItem
                  disabled={busy || branch.upstreamBehind > 0}
                  onClick={() => doPushBranch(branch)}
                >
                  {branch.upstreamBehind > 0
                    ? `Push to ${branch.upstream} (diverged)`
                    : `Push to ${branch.upstream}`}
                </ContextMenuItem>
              )}
              {/* Publish an unpushed / upstream-deleted branch. One remote →
                  a single item (the classic "Publish branch" when it's origin,
                  else "Publish to {remote}"); multiple remotes → one flat item
                  per remote (origin first, then alphabetical), each passing its
                  explicit destination. Always-visible flat rows — keyboard nav is
                  inherited from the menu. */}
              {publishRemotes.length === 1 ? (
                <ContextMenuItem
                  disabled={busy}
                  onClick={() => doPushBranch(branch, publishRemotes[0])}
                >
                  {publishRemotes[0] === "origin"
                    ? "Publish branch"
                    : `Publish to ${publishRemotes[0]}`}
                </ContextMenuItem>
              ) : (
                publishRemotes.map((r) => (
                  <ContextMenuItem
                    key={r}
                    disabled={busy}
                    onClick={() => doPushBranch(branch, r)}
                  >
                    Publish to {r}
                  </ContextMenuItem>
                ))
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={() => openRename(branch.name)}>
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => copyText(branch.name, "Branch name copied")}
          >
            Copy branch name
          </ContextMenuItem>
          <ContextMenuItem
            disabled={branch.isCurrent}
            onClick={() => setArchived(branch.name, !branch.archived)}
          >
            {branch.archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {inWorktree && (
            <ContextMenuItem
              onClick={() => {
                const wtPath = worktreeByBranch.get(branch.name);
                const wt = (userWorktrees.data ?? []).find(
                  (w) => w.path === wtPath,
                );
                if (!wt) return;
                setOpen(false);
                setRemoveWorktreeTarget(wt);
              }}
            >
              Remove worktree…
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={deletionBlocked || inWorktree}
            onClick={() => {
              setOpen(false);
              setDeleteTarget(branch.name);
            }}
          >
            {deletionBlocked
              ? "Delete… (protected)"
              : inWorktree
                ? "Delete… (in worktree)"
                : "Delete…"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  // A remote-only branch: lighter than a local row (muted, a leading "bring it
  // down" glyph). Clicking checks it out, which `git switch` turns into a local
  // tracking branch — routed through `switchTo` so in-progress changes are handled.
  const renderRemoteRow = (branch: RemoteBranch) => {
    // A protected name is protected on the remote too — reuse the local rule.
    const deletionBlocked = isDeletionBlocked(rulesConfig, branch.name);
    return (
      <ContextMenu key={`remote/${branch.remote}/${branch.name}`}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              data-row={branch.name}
              title={`Check out ${branch.name} — creates a local branch tracking ${branch.remote}/${branch.name}`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
              onClick={() => switchTo(branch.name, branch.remote)}
            >
              <CloudArrowDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{branch.name}</span>
              {multipleRemotes && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {branch.remote}
                </span>
              )}
              {branch.lastCommitDate && (
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {formatRelativeTime(branch.lastCommitDate)}
                </span>
              )}
            </button>
          }
        />
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem onClick={() => switchTo(branch.name, branch.remote)}>
            Check out
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => copyText(branch.name, "Branch name copied")}
          >
            Copy branch name
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* The Remote section dedupes a name across remotes to one row, so
              this targets THIS row's remote; after invalidation a same-name row
              from another remote may reappear. That's expected. */}
          <ContextMenuItem
            disabled={deletionBlocked}
            onClick={() => {
              setOpen(false);
              setRemoteDeleteTarget({
                remote: branch.remote,
                name: branch.name,
              });
            }}
          >
            {deletionBlocked
              ? `Delete on ${branch.remote}… (protected)`
              : `Delete on ${branch.remote}…`}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setBranchFilter("");
            setActiveBranch(null);
          }
        }}
      >
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              // Large shrink factor makes the branch label absorb essentially
              // all header space pressure before the repo name or CI badge give
              // way (flex removes space proportionally to factor × base size),
              // so the header cascade collapses branch (20) → CI badge (4) →
              // repo (1).
              className="min-w-0 shrink-20"
              disabled={busy || amending}
              title={
                amending
                  ? "Finish or stop amending to switch branches"
                  : undefined
              }
            >
              <GitBranchIcon data-icon="inline-start" />
              <span
                className="min-w-0 truncate"
                // Only expose the full label as a tooltip when it's actually
                // clipped — measured just-in-time on hover, so no ref needed.
                // Remove the attribute (not title="") when unclipped: an empty
                // title="" is still a title in Chromium and would suppress the
                // Button's own conditional (amending) title above.
                onMouseEnter={(e) => {
                  const el = e.currentTarget;
                  if (el) {
                    if (el.scrollWidth > el.clientWidth)
                      el.title = currentLabel;
                    else el.removeAttribute("title");
                  }
                }}
              >
                {currentLabel}
              </span>
              {head?.detached && (
                <Badge variant="secondary" className="ml-1 shrink-0">
                  detached
                </Badge>
              )}
              <CaretDownIcon data-icon="inline-end" />
            </Button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup
              className="w-108 rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
              // Arrow keys move through the branch rows whether focus is on the
              // filter input, a row, or the popup itself (Esc/Tab pass through).
              onKeyDown={onBranchKeyDown}
            >
              {inLinkedWorktree && (
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px]">
                  <TreeStructureIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    In worktree{" "}
                    <span className="font-medium text-foreground">
                      {currentWorktreeName}
                    </span>{" "}
                    — a checkout lands here
                  </span>
                  {mainWorktree && (
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
                      onClick={() => {
                        setOpen(false);
                        openWorktree(mainWorktree.path);
                      }}
                    >
                      Open main workspace
                    </button>
                  )}
                </div>
              )}
              <div className="border-b p-2">
                <Input
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder="Filter branches"
                  className="h-7"
                  autoComplete="off"
                />
              </div>
              <div className="max-h-60 overflow-y-auto">
                {visibleBranches.length === 0 &&
                  archivedBranches.length === 0 &&
                  remoteOnly.length === 0 && (
                    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                      {branchFilter.trim()
                        ? `No branches match "${branchFilter.trim()}"`
                        : "No branches"}
                    </p>
                  )}
                {visibleBranches.map(renderBranchRow)}
                {archivedBranches.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setShowArchived((v) => !v)}
                    >
                      <CaretDownIcon
                        className={`size-3 transition-transform ${
                          showArchived ? "" : "-rotate-90"
                        }`}
                        weight="bold"
                      />
                      Archived ({archivedBranches.length})
                    </button>
                    {showArchived && archivedBranches.map(renderBranchRow)}
                  </>
                )}
                {remoteOnly.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setShowRemote((v) => !v)}
                      title="Branches on your remotes you haven't checked out yet"
                    >
                      <CaretDownIcon
                        className={`size-3 transition-transform ${
                          showRemote ? "" : "-rotate-90"
                        }`}
                        weight="bold"
                      />
                      Remote ({remoteOnly.length})
                    </button>
                    {showRemote && remoteOnly.map(renderRemoteRow)}
                  </>
                )}
              </div>
              {otherWorktrees.length > 0 && (
                <div className="border-t py-1">
                  <p className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
                    Worktrees
                  </p>
                  {otherWorktrees.map((w) => (
                    <button
                      key={w.path}
                      type="button"
                      data-row={w.path}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                      onClick={() => {
                        setOpen(false);
                        openWorktree(w.path);
                      }}
                    >
                      <TreeStructureIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {w.isDetached ? "detached HEAD" : w.branch || "—"}
                      </span>
                      {w.isMain && (
                        <Badge variant="secondary" className="shrink-0">
                          Main
                        </Badge>
                      )}
                      <span
                        className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground"
                        onMouseEnter={(e) => {
                          const el = e.currentTarget;
                          // Full path is the useful tooltip (the row already
                          // shows the folder name). removeAttribute, not
                          // title="", so an unclipped row leaves no empty tooltip.
                          if (el.scrollWidth > el.clientWidth)
                            el.title = w.path;
                          else el.removeAttribute("title");
                        }}
                      >
                        {baseName(w.path)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="border-t py-1">
                <MenuRow onClick={openCreate}>New branch…</MenuRow>
                <MenuRow
                  disabled={!currentName}
                  onClick={() => {
                    if (!currentName) return;
                    openRename(currentName);
                  }}
                >
                  Rename current branch…
                </MenuRow>
                <MenuRow
                  disabled={
                    !currentName || isDeletionBlocked(rulesConfig, currentName)
                  }
                  onClick={() => {
                    if (!currentName) return;
                    setOpen(false);
                    setDeleteTarget(currentName);
                  }}
                >
                  {currentName && isDeletionBlocked(rulesConfig, currentName)
                    ? "Delete current branch… (protected)"
                    : "Delete current branch…"}
                </MenuRow>
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    setCleanupOpen(true);
                  }}
                >
                  Clean up branches…
                </MenuRow>
              </div>
              <div className="border-t py-1">
                <MenuRow
                  disabled={!hasChanges}
                  onClick={() => {
                    setOpen(false);
                    setDiscardAllOpen(true);
                  }}
                >
                  Discard all changes…
                </MenuRow>
                <MenuRow
                  disabled={!hasChanges}
                  onClick={() => {
                    setOpen(false);
                    setStashAllOpen(true);
                  }}
                >
                  Stash all changes…
                </MenuRow>
                <MenuRow
                  disabled={stashes === 0}
                  onClick={() => {
                    setOpen(false);
                    setStashPopOpen(true);
                  }}
                >
                  Pop latest stash{stashes > 0 ? ` (${stashes})` : ""}…
                </MenuRow>
                <MenuRow
                  disabled={stashes === 0}
                  onClick={() => {
                    setOpen(false);
                    setStashesView("stashes");
                    setStashesOpen(true);
                  }}
                >
                  View stashes{stashes > 0 ? ` (${stashes})` : ""}…
                </MenuRow>
                {/* Not gated on stash count — orphaned work commonly exists
                    with zero live stashes. */}
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    setStashesView("recoverable");
                    setStashesOpen(true);
                  }}
                >
                  Recover lost work…
                </MenuRow>
                <MenuRow
                  onClick={() => {
                    setOpen(false);
                    setOpHistoryOpen(true);
                  }}
                >
                  Operation history…
                </MenuRow>
              </div>
              <div className="border-t py-1">
                <MenuRow
                  disabled={
                    !defaultName ||
                    !currentName ||
                    defaultName === currentName ||
                    busy
                  }
                  onClick={() =>
                    currentName && doUpdateFromDefault(currentName)
                  }
                >
                  Update from {defaultName ?? "default branch"}
                </MenuRow>
                <MenuRow
                  disabled={otherBranches.length === 0 || !canMergeIntoCurrent}
                  onClick={() => openPicker("merge")}
                >
                  {lockCurrent
                    ? "Merge into current branch… (requires PR)"
                    : "Merge into current branch…"}
                </MenuRow>
                <MenuRow
                  disabled={otherBranches.length === 0 || !canSquashIntoCurrent}
                  onClick={() => openPicker("squash")}
                >
                  Squash and merge into current branch…
                </MenuRow>
                <MenuRow
                  disabled={otherBranches.length === 0 || lockCurrent}
                  onClick={() => openPicker("rebase")}
                >
                  Rebase current branch…
                </MenuRow>
                <MenuRow
                  disabled={
                    !currentName ||
                    otherBranches.length < 2 ||
                    lockCurrent ||
                    busy
                  }
                  onClick={openRebaseOnto}
                >
                  Change base…
                </MenuRow>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <CreateBranchDialog
        repoPath={repoPath}
        open={createOpen}
        onOpenChange={setCreateOpen}
        rulesConfig={rulesConfig}
        aiEnabled={aiEnabled}
        aiConfigured={aiConfigured}
        hasChanges={hasChanges}
        headExists={headExists}
        entries={status.data?.entries ?? []}
        allBranchNames={allBranches.map((b) => b.name)}
        currentName={currentName}
        defaultName={defaultName}
        onOpenSettings={openSettings}
      />

      <RenameBranchDialog
        repoPath={repoPath}
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        aiEnabled={aiEnabled}
        aiConfigured={aiConfigured}
        hasChanges={hasChanges}
        headExists={headExists}
        entries={status.data?.entries ?? []}
        allBranchNames={allBranches.map((b) => b.name)}
        onOpenSettings={openSettings}
      />

      <CleanupBranchesDialog
        repoPath={repoPath}
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        branches={allBranches}
        defaultBranch={defaultName}
        currentBranch={currentName}
        isProtected={(name) => isDeletionBlocked(rulesConfig, name)}
        isInWorktree={(name) => worktreeByBranch.has(name)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onCancel={() => setDeleteTarget(null)}
        title="Delete branch?"
        body={
          <>
            Deletes {deleteTarget} locally, including commits that exist only on
            it.
            {deleteTarget === currentName &&
              " You'll be switched to another branch first."}
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        pending={deleteBranch.isPending || checkout.isPending}
        onConfirm={doDelete}
      />

      <ConfirmDialog
        open={remoteDeleteTarget !== null}
        onCancel={() => setRemoteDeleteTarget(null)}
        title={
          remoteDeleteTarget
            ? `Delete branch on ${remoteDeleteTarget.remote}?`
            : "Delete branch on remote?"
        }
        body={
          remoteDeleteTarget ? (
            <>
              Deletes{" "}
              <span className="font-mono">{remoteDeleteTarget.name}</span> from{" "}
              <span className="font-mono">{remoteDeleteTarget.remote}</span> for
              everyone using that remote. This is a server-side delete and can't
              be undone from the app.
            </>
          ) : null
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        pending={deleteRemoteBranch.isPending}
        onConfirm={() => {
          if (!remoteDeleteTarget) return;
          const target = remoteDeleteTarget;
          deleteRemoteBranch.mutate(target, {
            onSuccess: () => {
              toast.success(`Deleted ${target.name} on ${target.remote}`);
              setRemoteDeleteTarget(null);
            },
            onError: (e) => {
              onError(e);
              setRemoteDeleteTarget(null);
            },
          });
        }}
      />

      <DeleteWorktreeDialog
        repoPath={repoPath}
        worktree={removeWorktreeTarget}
        onClose={() => setRemoveWorktreeTarget(null)}
      />

      <StashesDialog
        repoPath={repoPath}
        open={stashesOpen}
        onOpenChange={setStashesOpen}
        initialView={stashesView}
      />

      <OperationHistoryDialog
        repoPath={repoPath}
        open={opHistoryOpen}
        onOpenChange={setOpHistoryOpen}
      />

      <ConfirmDialog
        open={worktreeSwitchTarget !== null}
        onCancel={() => setWorktreeSwitchTarget(null)}
        title="Open worktree?"
        body={
          <>
            <span className="font-mono">{worktreeSwitchTarget?.name}</span> is
            checked out in another worktree. A branch can only be in one
            worktree at a time, so open that worktree instead of switching here.
          </>
        }
        confirmLabel="Open worktree"
        onConfirm={() => {
          const target = worktreeSwitchTarget;
          setWorktreeSwitchTarget(null);
          if (target) openWorktree(target.path);
        }}
      />

      <ConfirmDialog
        open={discardAllOpen}
        onCancel={() => setDiscardAllOpen(false)}
        title="Discard all changes?"
        body="All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin."
        confirmLabel="Discard all"
        confirmVariant="destructive"
        pending={discardAll.isPending}
        onConfirm={() =>
          discardAll.mutate(undefined, {
            onSuccess: () => {
              toast.success("All changes discarded");
              setDiscardAllOpen(false);
            },
            onError: (e) => {
              onError(e);
              setDiscardAllOpen(false);
            },
          })
        }
      />

      <ConfirmDialog
        open={stashAllOpen}
        onCancel={() => setStashAllOpen(false)}
        title="Stash all changes?"
        body={
          'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.'
        }
        confirmLabel="Stash changes"
        pending={stashAll.isPending}
        onConfirm={() =>
          stashAll.mutate(undefined, {
            onSuccess: () => {
              toast.success("Changes stashed");
              setStashAllOpen(false);
            },
            onError: (e) => {
              onError(e);
              setStashAllOpen(false);
            },
          })
        }
      />

      <ConfirmDialog
        open={stashPopOpen}
        onCancel={() => setStashPopOpen(false)}
        title="Pop latest stash?"
        body="Applies the most recent stash to your working tree and removes it from the stash list. If applying conflicts, the stash is kept."
        confirmLabel="Pop stash"
        pending={stashPop.isPending}
        onConfirm={() =>
          stashPop.mutate(undefined, {
            onSuccess: () => {
              toast.success("Stash restored");
              setStashPopOpen(false);
            },
            onError: (e) => {
              onError(e);
              setStashPopOpen(false);
            },
          })
        }
      />

      <BranchMergePickerDialog
        repoPath={repoPath}
        mode={pickerMode}
        onClose={() => setPickerMode(null)}
        onRun={runPicker}
        otherBranches={otherBranches}
        currentLabel={currentLabel}
      />

      <RebaseOntoDialog
        repoPath={repoPath}
        open={rebaseOntoOpen}
        onClose={() => setRebaseOntoOpen(false)}
        onRun={runRebaseOnto}
        otherBranches={otherBranches}
        currentLabel={currentLabel}
        defaultBranch={defaultName}
        hasChanges={hasChanges}
        isPushed={Boolean(head?.upstream) && !head?.upstreamGone}
      />

      <SwitchWithChangesDialog
        target={switchTarget}
        currentLabel={currentLabel}
        onCancel={() => setSwitchTarget(null)}
        onBringChanges={bringAndSwitch}
        onStashAndSwitch={stashAndSwitch}
        bringPending={checkout.isPending || checkoutRemote.isPending}
        stashPending={
          stashAll.isPending || checkout.isPending || checkoutRemote.isPending
        }
      />

      <PromoteWorktreeDialog
        key={promoteTarget?.path ?? "no-promote"}
        repoPath={repoPath}
        worktree={promoteTarget}
        onClose={() => setPromoteTarget(null)}
      />
    </>
  );
}
