import {
  ArrowSquareOutIcon,
  FilesIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MouseEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CompareBranchCombobox } from "@/features/compare/CompareBranchCombobox";
import { CommitContextMenuItems } from "@/features/history/CommitContextMenu";
import {
  checkoutCommitConfirm,
  checkoutCommitSuccessToast,
  cherryPickCommitConfirm,
  revertCommitConfirm,
} from "@/features/history/commit-confirms";
import {
  CreateRefFromCommitDialog,
  createRefFromCommitFormOpts,
} from "@/features/history/HistoryDialogs";
import { CreatePrDialog } from "@/features/pulls/CreatePrDialog";
import { suppressContextMenu } from "@/lib/context-menu";
import { useAppForm } from "@/lib/form";
import {
  forgeFeatureReady,
  useBranches,
  useCheckoutCommit,
  useCherryPick,
  useCompareBranches,
  useCreateBranch,
  useCreateTag,
  useDefaultBranch,
  useForgeStatus,
  useHoverPrefetch,
  usePrefetchCommit,
  usePrsForBranch,
  useRepoStatus,
  useRevertCommit,
} from "@/lib/git/queries";
import { sanitizeRefName } from "@/lib/git/ref-name";
import type { CommitSummary } from "@/lib/git/types";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";

export function ComparePanel({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const branches = useBranches(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const gh = useForgeStatus(repoPath);
  const compareBranch = useUiStore((s) => s.compareBranch);
  const setCompareBranch = useUiStore((s) => s.setCompareBranch);
  const compareCommitHash = useUiStore((s) => s.compareCommitHash);
  const selectCompareCommit = useUiStore((s) => s.selectCompareCommit);
  const openLocalPrCreate = useUiStore((s) => s.openLocalPrCreate);
  const prefetchCommit = usePrefetchCommit(repoPath);
  const hoverPrefetch = useHoverPrefetch();
  const onHoverCommit = (hash: string) =>
    hoverPrefetch(() => prefetchCommit(hash));
  const [prOpen, setPrOpen] = useState(false);

  const currentName = status.data?.branch?.name ?? null;
  const detached = status.data?.branch?.detached ?? false;
  // Opening a PR/MR follows the per-action create flag (GitHub + GitLab). The
  // "PRs for this branch" duplicate probe (`forge_prs_for_branch`) fires for any
  // provider whose PR reads are built, so an existing open PR/MR from this branch
  // flips the affordance to "View" instead of "Create".
  const prProbe = forgeFeatureReady(gh.data, "pullRequests");
  const isGitLab = gh.data?.provider === "gitlab";
  const prNoun = isGitLab ? "merge request" : "pull request";
  // Origin lens: this duplicate probe is about the FORK's own branch (the repo's
  // origin), not any upstream contribution. The lens switcher is a PR/Issues-tab
  // affordance; the Compare tab always reads origin.
  const branchPrs = usePrsForBranch(repoPath, currentName, prProbe, "origin");
  // Agent-session branches (`gd/session/*`) are app-internal — never offer them
  // as a compare target (the PR button would even push one), like BranchSwitcher.
  // Archived branches are hidden here too, matching BranchSwitcher (they were
  // archived to get them out of the way); archiving a branch that was the
  // compare target auto-falls-back via the default effect below.
  const otherBranches = (branches.data ?? []).filter(
    (b) => !b.isCurrent && !b.name.startsWith("gd/session/") && !b.archived,
  );
  // Fallback when the default branch isn't offered: the most recently committed
  // other branch — the same row the picker surfaces first, so the auto-pick
  // matches the top of the list the user sees (not raw git ref order).
  const firstOther = otherBranches.length
    ? otherBranches.reduce((a, b) =>
        b.lastCommitDate > a.lastCommitDate ? b : a,
      ).name
    : null;
  const compareValid =
    compareBranch !== null &&
    otherBranches.some((b) => b.name === compareBranch);
  const defaultName = defaultBranch.data ?? null;
  // Only pick the default branch when it's actually offered: an archived default
  // must fall back to `firstOther`, else `compareValid` stays false forever and
  // the effect keeps firing a no-op set. Stable primitive for the effect deps.
  const defaultOffered = otherBranches.some((b) => b.name === defaultName);

  // Default the comparison to the default branch (when offered), else the first
  // other branch.
  useEffect(() => {
    if (firstOther === null || compareValid) return;
    setCompareBranch(defaultOffered && defaultName ? defaultName : firstOther);
  }, [firstOther, compareValid, defaultOffered, defaultName, setCompareBranch]);

  const comparison = useCompareBranches(repoPath, compareBranch, currentName);

  const ahead = comparison.data?.ahead ?? [];
  const behind = comparison.data?.behind ?? [];
  const canPr = forgeFeatureReady(gh.data, "mrCreate");
  // An open PR from the current branch into the compared branch already exists.
  // The probe is origin-pinned (above), so a cross-repository row heads from
  // someone else's fork and must not flip Create into View.
  const existingPr = (branchPrs.data ?? []).find(
    (p) => p.baseRefName === compareBranch && !p.crossRepository,
  );

  useHotkeyAction(
    "create-pr",
    () => setPrOpen(true),
    Boolean(canPr && compareBranch && !existingPr && ahead.length > 0),
  );
  useHotkeyAction(
    "create-local-pr",
    () =>
      openLocalPrCreate({
        defaultHead: currentName ?? undefined,
        defaultBase: compareBranch ?? undefined,
      }),
    Boolean(compareBranch && compareBranch !== currentName && ahead.length > 0),
  );

  // The commit the one shared context menu acts on. Revert is only OFFERED for
  // ahead commits — the side already in this branch's history.
  const [menuTarget, setMenuTarget] = useState<{
    hash: string;
    onCurrentBranch: boolean;
  } | null>(null);
  const [branchHash, setBranchHash] = useState<string | null>(null);
  const [tagHash, setTagHash] = useState<string | null>(null);
  const shownBranchHash = useRetained(branchHash);
  const shownTagHash = useRetained(tagHash);

  const checkoutCommit = useCheckoutCommit(repoPath);
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const createBranch = useCreateBranch(repoPath);
  const createTag = useCreateTag(repoPath);

  const onError = (e: unknown) => toastError(e);

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

  // The commit-level confirms are the shared ones History asks, so no route can
  // pose a different question than its twin.
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

  async function doCherryPick(hash: string) {
    const ok = await useConfirm
      .getState()
      .ask(cherryPickCommitConfirm(hash, currentName));
    if (!ok) return;
    cherryPick.mutate(hash, {
      onSuccess: (applied) => {
        if (applied) {
          toast.success(`Cherry-picked ${hash.slice(0, 7)}`);
        } else {
          toast.info(
            "Nothing to cherry-pick — these changes are already on this branch.",
          );
        }
      },
      onError,
    });
  }

  // One shared context menu for both lists (capture phase, so it records the
  // right-clicked row before the menu opens). Right-clicking a commit selects it
  // (standard desktop behavior), so the menu and the diff panel always describe
  // the same commit; non-commit targets (the "All changes" row, headers, blank
  // space) get no menu.
  function handleContextMenu(e: MouseEvent) {
    const suppress = () => {
      setMenuTarget(null);
      suppressContextMenu(e);
    };
    const hash = (e.target as HTMLElement)
      .closest("[data-row]")
      ?.getAttribute("data-row");
    if (!hash) return suppress();
    const onCurrentBranch = ahead.some((c) => c.hash === hash);
    if (!onCurrentBranch && !behind.some((c) => c.hash === hash)) {
      return suppress();
    }
    selectCompareCommit(hash);
    setMenuTarget({ hash, onCurrentBranch });
  }

  if (status.isPending || branches.isPending)
    return (
      <div className="space-y-2 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );

  if (detached || !currentName) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>You're on a detached HEAD</EmptyTitle>
          <EmptyDescription>
            Compare needs a checked-out branch. Switch to a branch to see how it
            differs from another.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchAction("show-branches")}
          >
            <GitBranchIcon data-icon="inline-start" />
            Switch branch…
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (otherBranches.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>No other branches</EmptyTitle>
          <EmptyDescription>
            Compare shows how <span className="font-mono">{currentName}</span>{" "}
            diverges from another branch. Create a branch to have something to
            compare against.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatchAction("new-branch")}
          >
            <GitBranchIcon data-icon="inline-start" />
            New branch…
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  // Arrow keys walk "All changes" → ahead → behind, mirroring the list.
  const navTargets: (string | null)[] = [
    null,
    ...ahead.map((c) => c.hash),
    ...behind.map((c) => c.hash),
  ];

  const onListKeyDown = listKeyboardNav({
    items: navTargets,
    activeIndex: navTargets.indexOf(compareCommitHash),
    onActivate: (target) => selectCompareCommit(target),
    rowKey: (target) => target ?? "all",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b p-2">
        <p className="px-1 text-xs text-muted-foreground">
          Compare <span className="font-mono">{currentName}</span> with
        </p>
        <CompareBranchCombobox
          repoPath={repoPath}
          branches={otherBranches}
          currentName={currentName}
          defaultName={defaultName}
          value={compareBranch}
          onValueChange={setCompareBranch}
        />
        {canPr && compareBranch && existingPr && (
          <Button
            variant="outline"
            size="sm"
            className="w-full cursor-pointer"
            onClick={() => openUrl(existingPr.url)}
            title={existingPr.title}
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            View {prNoun} #{existingPr.number}
            {existingPr.isDraft ? " (draft)" : ""}
          </Button>
        )}
        {canPr && compareBranch && !existingPr && (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            wrapperClassName="w-full"
            className="w-full"
            disabled={ahead.length === 0}
            reason={`${currentName} has no commits to propose onto ${compareBranch}`}
            title={`Open a ${prNoun} into ${compareBranch}`}
            onClick={() => setPrOpen(true)}
          >
            <GitPullRequestIcon data-icon="inline-start" />
            Create {prNoun}…
          </DisabledReasonButton>
        )}
        {compareBranch && compareBranch !== currentName && (
          <DisabledReasonButton
            variant="ghost"
            size="sm"
            wrapperClassName="w-full"
            className="w-full"
            disabled={ahead.length === 0}
            reason={`${currentName} has no commits to propose onto ${compareBranch}`}
            title={`Propose merging ${currentName} into ${compareBranch} locally`}
            onClick={() =>
              openLocalPrCreate({
                defaultHead: currentName ?? undefined,
                defaultBase: compareBranch ?? undefined,
              })
            }
          >
            <GitBranchIcon data-icon="inline-start" />
            Create local PR…
          </DisabledReasonButton>
        )}
      </div>

      {canPr && compareBranch && !existingPr && (
        <CreatePrDialog
          repoPath={repoPath}
          defaultBase={compareBranch}
          defaultHead={currentName}
          open={prOpen}
          onOpenChange={setPrOpen}
        />
      )}

      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className="flex min-h-0 flex-1 flex-col"
              onKeyDown={onListKeyDown}
              role="listbox"
              aria-label="Compare selection"
              onContextMenuCapture={handleContextMenu}
            />
          }
        >
          <button
            type="button"
            data-row="all"
            role="option"
            aria-selected={compareCommitHash === null}
            className={cn(
              "flex w-full shrink-0 items-center gap-2 border-b px-3 py-2 text-left text-xs",
              compareCommitHash === null
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/60",
            )}
            onClick={() => selectCompareCommit(null)}
          >
            <FilesIcon className="size-3.5 shrink-0" />
            <span className="font-medium">All changes</span>
          </button>

          {comparison.isPending ? (
            <ListRowSkeletons rows={2} lines={2} name="commits" />
          ) : (
            /* overflow-hidden contains the list's natural height (vendored Root
               is `relative`-only) so a long list can't leak a window scrollbar. */
            <ScrollArea className="min-h-0 flex-1 overflow-hidden">
              <CommitSection
                title={`${ahead.length} ahead`}
                subtitle={`on ${currentName}, not on ${compareBranch}`}
                commits={ahead}
                selectedHash={compareCommitHash}
                onSelect={selectCompareCommit}
                onHover={onHoverCommit}
              />
              <CommitSection
                title={`${behind.length} behind`}
                subtitle={`on ${compareBranch}, not on ${currentName}`}
                commits={behind}
                selectedHash={compareCommitHash}
                onSelect={selectCompareCommit}
                onHover={onHoverCommit}
              />
              {ahead.length === 0 && behind.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  These branches are even.
                </p>
              )}
            </ScrollArea>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-60">
          {menuTarget && (
            <CommitContextMenuItems
              hash={menuTarget.hash}
              actions={{
                checkout: doCheckoutCommit,
                revert: menuTarget.onCurrentBranch ? doRevertCommit : undefined,
                cherryPick: doCherryPick,
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
          )}
        </ContextMenuContent>
      </ContextMenu>

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
    </div>
  );
}

function CommitSection({
  title,
  subtitle,
  commits,
  selectedHash,
  onSelect,
  onHover,
}: {
  title: string;
  subtitle: string;
  commits: CommitSummary[];
  selectedHash: string | null;
  onSelect: (hash: string) => void;
  onHover: (hash: string) => void;
}) {
  if (commits.length === 0) return null;
  return (
    <div>
      <div className="sticky top-0 bg-muted/50 px-3 py-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      {commits.map((commit) => (
        <button
          type="button"
          key={commit.hash}
          data-row={commit.hash}
          role="option"
          aria-selected={selectedHash === commit.hash}
          className={cn(
            "block w-full border-b px-3 py-2 text-left",
            selectedHash === commit.hash
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted/60",
          )}
          onClick={() => onSelect(commit.hash)}
          onMouseEnter={() => onHover(commit.hash)}
        >
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <GitCommitIcon className="size-3 shrink-0 text-muted-foreground" />
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
          </p>
          <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
            {commit.author} • <RelativeTime date={commit.date} />
          </p>
        </button>
      ))}
    </div>
  );
}
