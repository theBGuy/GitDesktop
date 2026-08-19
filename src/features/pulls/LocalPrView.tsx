import { Popover } from "@base-ui/react/popover";
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CheckIcon,
  DotsThreeIcon,
  GithubLogoIcon,
  GitlabLogoIcon,
  GitMergeIcon,
  InfoIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TagIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BranchDiffView } from "@/features/compare/BranchDiffView";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { CommitsList } from "@/features/conversations/CommitsList";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { LocalComment } from "@/features/conversations/LocalComment";
import { useLocalConversation } from "@/features/conversations/useLocalConversation";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import { useStashReapplyRecovery } from "@/features/repository/useStashReapplyRecovery";
import { isMergeMethodAllowed } from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
import { copyText } from "@/lib/clipboard";
import { gitBranchDiff, type MergeStrategy } from "@/lib/git/api";
import {
  forgeFeatureReady,
  useBranchDiffFiles,
  useCompareBranches,
  useConflictPreview,
  useDefaultBranch,
  useForgeStatus,
  useMergeLocalPr,
  useRepoStatus,
  useUpdateBranchFrom,
} from "@/lib/git/queries";
import { useGenerateChordHint } from "@/lib/hotkeys/useGenerateChord";
import type { PrSection } from "@/lib/pulls/pr-section";
import { useLocalPrs, useUpdateLocalPr } from "@/lib/pulls/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { LinkedIssuesField } from "./LinkedIssuesField";
import { LocalPrLifecycleRow } from "./LocalPrTimeline";
import { PromoteLocalPrDialog } from "./PromoteLocalPrDialog";
import { PrReviewPanel } from "./PrReviewPanel";
import {
  coalesceCommitRuns,
  PushedCommitsRow,
  sortTimeline,
  type TimelineEntry,
} from "./PrTimeline";
import { ResolveConflictsView } from "./ResolveConflictsView";
import {
  useCancelOnIdentityChange,
  useGeneratePrDescription,
} from "./useGeneratePrDescription";
import {
  composeBodyWithRefs,
  splitBodyRefBlock,
  useLinkedIssueChips,
} from "./useLinkedIssueChips";

/** The verb a completed merge reports, per strategy. */
const MERGED_VERB: Record<MergeStrategy, string> = {
  merge: "Merged",
  squash: "Squashed and merged",
  rebase: "Rebased and merged",
  fast_forward: "Merged",
};

/** Tab labels for this view's sections. `files` is undefined until the branch-diff
 *  read lands, and the tab then shows no count rather than a wrong one. */
const SECTION_LABEL: Record<
  PrSection,
  (counts: {
    comments: number;
    commits: number;
    files: number | undefined;
  }) => string
> = {
  conversation: (c) => `Conversation (${c.comments})`,
  commits: (c) => `Commits (${c.commits})`,
  files: (c) => `Files${c.files === undefined ? "" : ` (${c.files})`}`,
  review: () => "Review",
};

export function LocalPrView({
  repoPath,
  id,
}: {
  repoPath: string;
  id: string;
}) {
  const prs = useLocalPrs(repoPath);
  const pr = prs.data?.find((p) => p.id === id);
  const update = useUpdateLocalPr(repoPath);
  const merge = useMergeLocalPr(repoPath);
  const updateBranchFrom = useUpdateBranchFrom(repoPath);
  const recovery = useStashReapplyRecovery(repoPath);
  const status = useRepoStatus(repoPath);
  const selectedPr = useUiStore((s) => s.selectedPr);
  const pendingPrSection = useUiStore((s) => s.pendingPrSection);
  const setPendingPrSection = useUiStore((s) => s.setPendingPrSection);
  const [section, setSection] = useState<PrSection>("conversation");
  // Commits-tab drill-in: the selected commit's hash, or null for the list.
  // Reset when the viewed PR changes (below).
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
    null,
  );
  const aiEnabled = useAiEnabled();
  // The sub-tabs the strip renders — every writer of `section` gates on this, so
  // no path can select a tab that isn't there. A local PR has no forge, so the
  // Review tab rides the AI setting alone (no capability axis to consult).
  const availableSections = useMemo<PrSection[]>(
    () =>
      aiEnabled
        ? ["conversation", "commits", "files", "review"]
        : ["conversation", "commits", "files"],
    [aiEnabled],
  );
  // A notification's click-through lands here via a pending hint; switch to the
  // hinted sub-tab once if it's available, then clear the hint either way — an
  // unusable hint must not survive to fire against a later PR. Guarded on this
  // being the *selected* PR so a still-mounted lagging view (deferredPr) can't
  // swallow the hint first.
  useEffect(() => {
    const isSelected = selectedPr?.kind === "local" && selectedPr.id === id;
    if (pendingPrSection !== null && isSelected) {
      if (availableSections.includes(pendingPrSection))
        setSection(pendingPrSection);
      setPendingPrSection(null);
    }
  }, [
    pendingPrSection,
    setPendingPrSection,
    selectedPr,
    id,
    availableSections,
  ]);
  // Availability can drop away under the selection (Hide AI toggled), which
  // would leave a blank body under a strip with no pressed tab — fall back to
  // the tab every PR always has. Layout effect: a passive one paints that empty
  // frame before reconciling.
  useLayoutEffect(() => {
    if (!availableSections.includes(section)) setSection("conversation");
  }, [availableSections, section]);
  const rulesConfig = useEffectiveBranchRules(repoPath);
  const {
    comment,
    setComment,
    labelInput,
    setLabelInput,
    deletingCommentId,
    setDeletingCommentId,
    composerRef,
    quoteReply,
    addComment,
    editComment,
    deleteComment,
    setCommentHidden,
    addLabel,
    removeLabel,
  } = useLocalConversation(id, pr, (mutate) => {
    if (pr) update.mutate({ id: pr.id, mutate });
  });
  const [promoteOpen, setPromoteOpen] = useState(false);
  const ghStatus = useForgeStatus(repoPath);
  // Linked-issue chips on the local-PR edit path: the chips OWN the trailing ref
  // block (peeled at open, re-composed on save). A local PR's `Closes #N` lines
  // survive promotion verbatim into the real forge PR, so these become real
  // closing refs later — that's intended.
  const canLinkIssues =
    !!ghStatus.data && forgeFeatureReady(ghStatus.data, "issues");
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      if (!pr) return;
      const finalBody = canLinkIssues
        ? composeBodyWithRefs(body, linkedIssues)
        : body;
      await update.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({ ...cur, title, body: finalBody }),
      });
    },
  });
  // A different PR must never inherit this one's drill-in, half-typed label, or
  // open delete/promote/edit dialogs — a render-time state adjustment, not an
  // effect.
  const [lastId, setLastId] = useState(id);
  if (id !== lastId) {
    setLastId(id);
    setSelectedCommitHash(null);
    setLabelInput("");
    setDeletingCommentId(null);
    setPromoteOpen(false);
    edit.setOpen(false);
  }
  const prGen = useGeneratePrDescription(repoPath);
  // The edit dialog's in-flight generation belongs to the PR it was started on; the
  // cancel is imperative, so it rides an effect rather than the block above.
  useCancelOnIdentityChange(id, prGen.cancel);
  // The generate-commit-message binding's title suffix. The chord itself lives in
  // EditTitleBodyDialog; this is only the label, so a rebinding drives both.
  const generateHint = useGenerateChordHint();

  const comparison = useCompareBranches(
    repoPath,
    pr?.base ?? null,
    pr?.head ?? null,
  );
  // Shared chip state machine — enabled only while the edit dialog is open (and
  // the tracker is usable). Local PRs have no lens concept, so read the forge's
  // own issues ("origin"). Body refs are peeled into chips at open (`resetWith`
  // in openEdit), so the body and the chips are never two sources of truth.
  const {
    chips: linkedIssues,
    resetWith: resetLinkedIssues,
    toggleKeyword: toggleIssueKeyword,
    remove: removeIssue,
    pick: pickIssue,
    buildCandidates: buildIssueCandidates,
    upsertFromDraft: upsertAiIssues,
  } = useLinkedIssueChips({
    repoPath,
    lens: "origin",
    enabled: canLinkIssues && edit.open,
    headBranch: pr?.head ?? null,
    commitSubjects: comparison.data?.ahead?.map((c) => c.subject) ?? [],
  });
  const diffFiles = useBranchDiffFiles(
    repoPath,
    pr?.base ?? null,
    pr?.head ?? null,
  );
  // The merge runs in an isolated worktree, so a dirty working tree only blocks
  // it when `base` IS the branch you're currently on (git won't check that ref
  // out into a second worktree while it has uncommitted tracked changes). When
  // base is some other branch, the merge never touches your tree.
  const baseIsCurrent =
    pr !== undefined && status.data?.branch?.name === pr.base;
  const hasTrackedChanges = (status.data?.entries ?? []).some(
    (e) =>
      e.staged !== null || (e.unstaged !== null && e.unstaged !== "untracked"),
  );
  const dirtyBlocks = baseIsCurrent && hasTrackedChanges;
  const canMerge = pr?.status === "open" && pr.approved;
  // Predict whether the merge will conflict, shown as a calm line by the Merge
  // button. `git_conflict_preview` is a read-only merge-tree prediction, so run
  // it whenever the PR is open — even when merging is currently blocked (not
  // approved / dirty tree), the user still wants to see the prediction.
  const conflictPreview = useConflictPreview(
    repoPath,
    pr?.base ?? "",
    pr?.head ?? "",
    pr?.status === "open",
  );
  const defaultBranch = useDefaultBranch(repoPath);

  if (!pr) {
    return (
      <DiffPlaceholder message="This local pull request no longer exists" />
    );
  }

  const ahead = comparison.data?.ahead ?? [];
  // Commits on `base` that `head` lacks — i.e. how far the PR's head branch has
  // fallen behind base. Non-empty ⇒ offer GitHub's "Update branch".
  const behind = comparison.data?.behind ?? [];
  // A promotion pull request (main → staging): the HEAD is this repository's
  // default branch, so it stays permanently behind its base and "Update branch"
  // would merge the base back INTO the default branch, inverting the flow. The
  // head-is-default shape is the whole test — a topology probe false-positives on
  // stacked pull requests. staging → production has the same inversion and is not
  // covered.
  const promotionLike =
    Boolean(defaultBranch.data) && pr.head === defaultBranch.data;

  // AI title+description generation — shared by the Edit dialog's Generate button
  // and its mod+g chord. Verbatim the button's prior onClick body. `pr` is aliased
  // to a narrowed const so the (hoisted) function body sees it as defined.
  const prForGen = pr;
  function runGenerate() {
    // Local PRs have real local branches — the base..head branch-diff path works,
    // and (like create) keeps base GitHub prompt wording (no provider) and
    // proposes no labels. The trailing args are reviewer notes (none on an edit)
    // and the grounded issue candidates.
    prGen.generate(
      prForGen.base,
      prForGen.head,
      ahead.map((c) => c.subject),
      (d) => {
        edit.form.setFieldValue("title", d.title);
        edit.form.setFieldValue("body", d.body);
        // Union the model's proposed issue links into the chip cluster (same
        // rules as create — relate-default, dismissed-set, AI sparkle).
        upsertAiIssues({ closes: d.closes, relates: d.relates });
      },
      undefined,
      [],
      undefined,
      buildIssueCandidates(),
    );
  }
  const fileCount = diffFiles.data?.length;
  // Shared JiraRefRow sources for both header branches (conflict-takeover +
  // normal) so the two can't diverge. Branch name LAST so title/description
  // attribution wins a key that also appears in the branch name.
  const jiraRefSources = [
    { label: "title", text: pr.title },
    { label: "description", text: pr.body },
    { label: "branch name", text: pr.head },
  ];

  function toggleApprove() {
    if (!pr) return;
    update.mutate({
      id: pr.id,
      mutate: (cur) => ({ ...cur, approved: !cur.approved }),
    });
  }

  // A typed note rides Close/Reopen rather than being discarded by them.
  const draftRidesStateChange = !!comment.trim();

  /** Close/Reopen, carrying any typed note. The note is appended in the SAME
   *  record mutation as the status flip, so the store can never persist one
   *  without the other; the draft clears only once that write lands. */
  function setStatus(next: "open" | "closed") {
    // Appending the note makes this non-idempotent, and the mutate callback
    // re-reads the record from disk — so a second click lands after the first
    // note is already stored and would post it twice.
    if (!pr || update.isPending) return;
    const note = comment.trim();
    update.mutate(
      {
        id: pr.id,
        mutate: (cur) => ({
          ...cur,
          comments: note
            ? [
                ...cur.comments,
                {
                  id: crypto.randomUUID(),
                  body: note,
                  createdAt: new Date().toISOString(),
                },
              ]
            : cur.comments,
          status: next,
          closedAt: next === "closed" ? new Date().toISOString() : undefined,
        }),
      },
      {
        onSuccess: () => setComment(""),
        // Nothing was written, the note included — say so rather than leave a
        // silent no-op behind a button that promised to post it.
        onError: toastError,
      },
    );
  }

  function openEdit() {
    if (!pr) return;
    // The chips OWN the trailing ref block: peel any exact `Closes #N` /
    // `Relates to #N` lines off the end of the body into chips (keyword
    // preserved) and open the editor with the STRIPPED text. On save the block is
    // re-appended from chips. With the tracker unavailable there are no chips.
    if (canLinkIssues) {
      const { text, refs } = splitBodyRefBlock(pr.body, "native");
      edit.openEdit({ title: pr.title, body: text });
      resetLinkedIssues(refs);
    } else {
      edit.openEdit({ title: pr.title, body: pr.body });
    }
  }

  function doMerge(strategy: MergeStrategy) {
    if (!pr) return;
    const message = pr.body.trim() ? `${pr.title}\n\n${pr.body}` : pr.title;
    merge.mutate(
      { base: pr.base, head: pr.head, message, strategy },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "merged") {
            update.mutate({
              id: pr.id,
              mutate: (cur) => ({
                ...cur,
                status: "merged",
                mergedAt: new Date().toISOString(),
              }),
            });
            toast.success(
              `${MERGED_VERB[strategy]} ${pr.head} into ${pr.base}`,
            );
            return;
          }
          // Conflicts: the merge is paused in an isolated worktree (the user's
          // branch and working tree are untouched). Record it on the PR so this
          // view swaps to the in-place ResolveConflictsView, where the conflict
          // editor is pointed at that worktree.
          if (!outcome.worktreePath || !outcome.worktreeId) {
            toastError(
              new Error("Merge paused on conflicts but returned no worktree"),
            );
            return;
          }
          update.mutate({
            id: pr.id,
            mutate: (cur) => ({
              ...cur,
              pendingMerge: {
                base: pr.base,
                head: pr.head,
                strategy: strategy as "merge" | "squash" | "rebase",
                message,
                worktreePath: outcome.worktreePath as string,
                worktreeId: outcome.worktreeId as string,
                opId: outcome.opId,
                startedAt: new Date().toISOString(),
              },
            }),
          });
          toast.warning("Merge has conflicts — resolve them to finish");
        },
        onError: toastError,
      },
    );
  }

  // A calm status block above the Merge button: up to three INDEPENDENT lines —
  // the in-memory conflict prediction, the promotion note that stands in for the
  // Update branch button this shape hides, and (when merging is currently
  // blocked) the visible reason it's disabled. The reason is shown here because a
  // disabled <Button>'s `title` never surfaces a tooltip (the repo's
  // explain-disabled-actions gotcha).
  function renderMergeStatus() {
    if (!pr) return null;
    const p = conflictPreview.data;
    const blocked = !canMerge || dirtyBlocks;

    // Prediction line — nothing for up-to-date / fast-forward / unknown.
    let prediction: ReactNode = null;
    if (p?.status === "conflict") {
      const files = p.conflicts;
      const shown = files.slice(0, 3);
      const list =
        files.length <= 3
          ? shown.join(", ")
          : `${shown.join(", ")} and ${files.length - 3} more`;
      prediction = (
        <>
          <div className="flex items-start gap-1.5 text-warning">
            <WarningIcon className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0">
              This merge will conflict in{" "}
              <span className="font-mono">{list}</span>
            </span>
          </div>
          <div className="pl-5 text-muted-foreground">
            You'll resolve the conflicts in an editor — your working tree stays
            untouched.
          </div>
        </>
      );
    } else if (p?.status === "clean") {
      prediction = (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <CheckIcon className="size-3.5 shrink-0" />
          Merges cleanly
        </div>
      );
    }

    // Blocked-reason line — independent of the prediction.
    const reason = blocked ? (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" />
        {!canMerge
          ? "Approve this PR to merge"
          : "Commit or stash your changes to merge into the current branch"}
      </div>
    ) : null;

    // Names the direction the work travels, in place of the Update branch button
    // this arm hides. The count is true and stays visible; only the implied
    // catch-up goes away. The gap does NOT close on merge — merging the head into
    // the base ADDS a commit the head lacks — so the copy says it needs no closing.
    const promotion =
      promotionLike && behind.length > 0 ? (
        <div className="flex items-start gap-1.5 text-muted-foreground">
          <InfoIcon className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-mono">{pr.base}</span> has {behind.length}{" "}
            commit{behind.length === 1 ? "" : "s"}{" "}
            <span className="font-mono">{pr.head}</span> doesn't.{" "}
            <span className="font-mono">{pr.head}</span> is the repository's
            default branch, so this gap is expected and doesn't need closing.
            Updating the branch would merge{" "}
            <span className="font-mono">{pr.base}</span> back into{" "}
            <span className="font-mono">{pr.head}</span>.
          </span>
        </div>
      ) : null;

    if (!prediction && !reason && !promotion) return null;
    return (
      <div className="space-y-1 border-t px-3 py-1.5 text-xs">
        {prediction}
        {promotion}
        {reason}
      </div>
    );
  }

  // A merge paused on conflicts takes over the whole PR view: the merge lives in
  // an isolated worktree, and ResolveConflictsView drives its file list + editor +
  // Finish/Abort in place of the PR's normal sections and footer actions.
  if (pr.pendingMerge?.worktreePath) {
    return (
      <div className="flex h-full flex-col">
        <header className="space-y-2 border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <h2 className="text-sm font-medium">{pr.title}</h2>
            <span className="flex-1" />
            <Badge variant="secondary" className="capitalize">
              {pr.status}
            </Badge>
          </div>
          <JiraRefRow repoPath={repoPath} sources={jiraRefSources} />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{pr.head}</span>
            <span>→</span>
            <span className="font-mono">{pr.base}</span>
            <span>•</span>
            <span>
              local · <RelativeTime date={pr.createdAt} />
            </span>
          </div>
        </header>
        <ResolveConflictsView repoPath={repoPath} pr={pr} />
      </div>
    );
  }

  // The Merge control's state. Hoisted because the refusal has to sit on the
  // wrapping span while `disabled` sits on the trigger — a disabled trigger is
  // what actually keeps the menu shut.
  const mergeBlocked = !canMerge || merge.isPending || dirtyBlocks;
  const mergeReason = !canMerge
    ? "Approve the PR before merging"
    : dirtyBlocks
      ? "Commit or stash your changes before merging into the current branch"
      : `Merge ${pr.head} into ${pr.base}`;

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="text-sm font-medium">{pr.title}</h2>
          <span className="flex-1" />
          {pr.status === "open" && (
            <Button
              variant="outline"
              size="xs"
              onClick={openEdit}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
          )}
          <Badge
            variant={pr.status === "open" ? "default" : "secondary"}
            className="capitalize"
          >
            {pr.status}
          </Badge>
          {pr.approved && pr.status === "open" && (
            <Badge variant="secondary">approved</Badge>
          )}
          {pr.archived && <Badge variant="secondary">archived</Badge>}
        </div>
        <JiraRefRow repoPath={repoPath} sources={jiraRefSources} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{pr.head}</span>
          <span>→</span>
          <span className="font-mono">{pr.base}</span>
          <span>•</span>
          <span>
            local · <RelativeTime date={pr.createdAt} />
          </span>
        </div>
        {(pr.labels.length > 0 || pr.status === "open") && (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Trigger first, so it never shifts as chips come and go. */}
            {pr.status === "open" && (
              <Popover.Root>
                <Popover.Trigger
                  render={
                    <Button variant="ghost" size="xs" aria-label="Add label" />
                  }
                >
                  <TagIcon data-icon="inline-start" />
                  Labels
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner
                    align="start"
                    sideOffset={4}
                    className="isolate z-50"
                  >
                    <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                      <p className="px-1 pb-1.5 text-xs font-medium">
                        Add label
                      </p>
                      <div className="flex gap-2 px-1">
                        <Input
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addLabel();
                            }
                          }}
                          placeholder="e.g. bug, refactor"
                          className="h-7 flex-1"
                          autoComplete="off"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!labelInput.trim()}
                          onClick={addLabel}
                        >
                          Add
                        </Button>
                      </div>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
            {pr.labels.map((label) => (
              <span
                key={label}
                className="flex items-center gap-1 border px-1.5 py-0.5 text-[11px]"
              >
                {label}
                {pr.status === "open" && (
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeLabel(label)}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-1 pt-1">
          {availableSections.map((s) => (
            <Button
              key={s}
              variant={section === s ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={section === s}
              onClick={() => setSection(s)}
            >
              {SECTION_LABEL[s]({
                comments: pr.comments.length,
                commits: ahead.length,
                files: fileCount,
              })}
            </Button>
          ))}
        </div>
      </header>

      {aiEnabled && section === "review" && (
        <PrReviewPanel
          prKind="local"
          prRef={id}
          context={{
            title: pr.title,
            body: pr.body,
            commitSubjects: ahead.map((c) => c.subject),
            repoPath,
            // A local PR has no forge lens; "origin" keeps its per-PR review stores
            // on the keys they used before the lens dimension existed.
            lens: "origin",
            // `ahead` (git log) is newest-first, so the head is the first entry.
            headSha: ahead[0]?.hash,
            loadDiff: () =>
              gitBranchDiff(repoPath, pr.base, pr.head, 200000).then((d) => ({
                text: d.text,
                truncated: d.truncated,
                files: d.files,
              })),
          }}
          posting={update.isPending}
          // The body arrives pre-branded from the panel; stamp the synthetic
          // author so it renders as a GitDesktop-posted review, not authorless.
          // `opts` (asBot) is a remote-forge concern — ignored for local PRs.
          onPost={async (body) => {
            try {
              await update.mutateAsync({
                id: pr.id,
                mutate: (cur) => ({
                  ...cur,
                  comments: [
                    ...cur.comments,
                    {
                      id: crypto.randomUUID(),
                      body,
                      author: "GitDesktop",
                      createdAt: new Date().toISOString(),
                    },
                  ],
                }),
              });
            } catch (e) {
              toastError(e);
              throw e; // let the panel skip its success toast / text clear
            }
          }}
        />
      )}

      {section === "conversation" && (
        <>
          {/* overflow-hidden contains the thread's natural height (vendored Root is
              `relative`-only) so a long PR can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <div className="space-y-4 p-4">
              <div className="group flex items-start justify-between gap-2 border-b pb-3">
                <div className="min-w-0 flex-1">
                  {pr.body.trim() ? (
                    <Markdown>{pr.body}</Markdown>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No description.
                    </p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Description actions"
                        className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                      />
                    }
                  >
                    <DotsThreeIcon className="size-4" weight="bold" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onClick={() => quoteReply(pr.body)}>
                      Quote reply
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => copyText(pr.body, "Markdown copied")}
                    >
                      Copy markdown
                    </DropdownMenuItem>
                    {pr.status === "open" && (
                      <DropdownMenuItem onClick={openEdit}>
                        Edit
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {/* The merged activity feed: the created lifecycle marker +
                  commits + comments + a merged/closed marker, date-sorted
                  oldest→newest (matching the remote PR timeline). Each source
                  maps to a {date, sortKey, node} entry — comments keep every
                  callback they had before (they're relocated, not rewritten);
                  commits ride as bare markers that coalesce into a grouped
                  "pushed N commits" row. There's always a created row, so the
                  feed is never empty. */}
              {(() => {
                const entries: TimelineEntry[] = [];

                // Created — always present (there's always a createdAt).
                entries.push({
                  date: pr.createdAt,
                  sortKey: 0,
                  node: (
                    <LocalPrLifecycleRow
                      key="lifecycle-created"
                      kind="created"
                      date={pr.createdAt}
                    />
                  ),
                });

                // Commits from `ahead` — carried as bare markers; adjacent runs
                // coalesce into a single "pushed N commits" row after sorting.
                for (const c of ahead) {
                  entries.push({
                    date: c.date,
                    sortKey: 1,
                    commit: {
                      id: c.hash,
                      subject: c.subject,
                      shortSha: c.hash.slice(0, 7),
                      author: c.author,
                      date: c.date,
                    },
                  });
                }

                // Comments (existing cards, every callback preserved).
                for (const c of pr.comments) {
                  entries.push({
                    date: c.createdAt,
                    sortKey: 2,
                    node: (
                      <LocalComment
                        key={c.id}
                        comment={c}
                        onQuote={() => quoteReply(c.body)}
                        onSaveEdit={(body) => editComment(c.id, body)}
                        onDelete={() => setDeletingCommentId(c.id)}
                        onHide={() => setCommentHidden(c.id, true)}
                        onUnhide={() => setCommentHidden(c.id, false)}
                      />
                    ),
                  });
                }

                // Terminal lifecycle marker: merged, or closed (with a graceful
                // timestamp-less marker for older records that predate closedAt).
                if (pr.status === "merged") {
                  entries.push({
                    date: pr.mergedAt ?? "",
                    sortKey: 3,
                    node: (
                      <LocalPrLifecycleRow
                        key="lifecycle-merged"
                        kind="merged"
                        date={pr.mergedAt}
                      />
                    ),
                  });
                } else if (pr.status === "closed" && pr.closedAt) {
                  entries.push({
                    date: pr.closedAt,
                    sortKey: 3,
                    node: (
                      <LocalPrLifecycleRow
                        key="lifecycle-closed"
                        kind="closed"
                        date={pr.closedAt}
                      />
                    ),
                  });
                }

                // Coalesce adjacent commit markers into grouped "pushed N" rows;
                // everything else renders its own node.
                const rendered = coalesceCommitRuns(
                  sortTimeline(entries),
                  (run, runStart) => (
                    <PushedCommitsRow
                      key={`push-${runStart}-${run[0].id}`}
                      commits={run}
                      onSelectCommit={(hash) => {
                        setSelectedCommitHash(hash);
                        setSection("commits");
                      }}
                    />
                  ),
                );

                return <div className="space-y-4">{rendered}</div>;
              })()}
            </div>
          </ScrollArea>
          {/* Shown for closed PRs too, so you can comment / quote-reply after
              closing; approving stays open-only. */}
          <CommentComposer
            ref={composerRef}
            value={comment}
            onChange={setComment}
            onSubmit={addComment}
            onClear={() => setComment("")}
            submitLabel="Comment"
            ariaLabel="Leave a note"
            placeholder="Leave a note…"
            actions={
              pr.status === "open" && (
                <Button
                  variant={pr.approved ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={pr.approved}
                  onClick={toggleApprove}
                >
                  <CheckCircleIcon data-icon="inline-start" />
                  {pr.approved ? "Approved" : "Approve"}
                </Button>
              )
            }
          />
        </>
      )}

      {section === "commits" &&
        (selectedCommitHash ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedCommitHash(null)}
                aria-label="Back to commits"
                className="-ml-2 h-7 text-muted-foreground hover:text-foreground"
              >
                ‹ Commits
              </Button>
            </div>
            {/* Local commits exist in the repo, so the full commit detail (with
                its actions menu — checkout/revert/cherry-pick/amend) applies. */}
            <div className="min-h-0 flex-1">
              <CommitDetailView repoPath={repoPath} hash={selectedCommitHash} />
            </div>
          </div>
        ) : (
          <CommitsList
            commits={ahead.map((c) => ({
              id: c.hash,
              subject: c.subject,
              shortSha: c.hash.slice(0, 7),
              author: c.author,
              date: c.date,
            }))}
            emptyMessage="No commits to merge."
            onSelect={setSelectedCommitHash}
            selectedId={selectedCommitHash}
          />
        ))}

      {section === "files" && (
        <div className="min-h-0 flex-1">
          <BranchDiffView
            repoPath={repoPath}
            base={pr.base}
            compare={pr.head}
          />
        </div>
      )}

      {pr.status === "open" && renderMergeStatus()}

      <div className="flex items-center gap-2 border-t p-3">
        {pr.status === "open" && (
          <>
            {forgeFeatureReady(ghStatus.data, "mrCreate") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPromoteOpen(true)}
                title={`Push the branch and open this ${ghStatus.data?.provider === "gitlab" ? "merge request on GitLab" : "PR on GitHub"}`}
              >
                {ghStatus.data?.provider === "gitlab" ? (
                  <GitlabLogoIcon data-icon="inline-start" />
                ) : (
                  <GithubLogoIcon data-icon="inline-start" />
                )}
                Publish to{" "}
                {ghStatus.data?.provider === "gitlab" ? "GitLab" : "GitHub"}
              </Button>
            )}
            {/* The label swaps while a note rides along: the action changed
                meaning, and only the label reaches a viewer before the click. */}
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={update.isPending}
              reason="Saving…"
              onClick={() => setStatus("closed")}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close"}
            </DisabledReasonButton>
            <span className="flex-1" />
            {/* GitHub-style "Update branch": only when head has fallen behind
                base. Merges base into head (in a throwaway worktree, so it
                doesn't touch your working tree unless head IS your current
                branch) so the branch catches up; the repo-scoped invalidation
                then refreshes the comparison (behind → 0, this button hides)
                and the conflict preview. */}
            {behind.length > 0 && !promotionLike && (
              <DisabledReasonButton
                variant="outline"
                size="sm"
                // `promotionLike` reads false while `useDefaultBranch` is still
                // resolving, so an enabled button there is a demotion that hasn't
                // decided yet. Held, not hidden: a control that vanishes and
                // reappears is worse than one that says what it's waiting on.
                //
                // PENDING only, never `!isSuccess`: a FAILED read would otherwise
                // disable the button forever behind a "checking…" that is no longer
                // true. An error falls open to the ordinary button instead — the
                // same direction the rest of this feature takes, where an
                // unprovable answer means today's behavior rather than a
                // withheld one. (The query is never `enabled: false`, so `isPending`
                // here can only mean in-flight.)
                disabled={
                  updateBranchFrom.isPending ||
                  recovery.pending ||
                  defaultBranch.isPending
                }
                reason={
                  defaultBranch.isPending
                    ? "Checking which branch is the default…"
                    : undefined
                }
                title={`Merge ${pr.base} into ${pr.head} to catch it up`}
                onClick={() =>
                  updateBranchFrom.mutate(
                    { branch: pr.head, base: pr.base },
                    {
                      onSuccess: () =>
                        toast.success(`Updated ${pr.head} from ${pr.base}`),
                      // Only an in-place update (head IS the current branch) can
                      // be refused over uncommitted changes — the throwaway
                      // worktree path is always clean. Anything else toasts.
                      onError: (e) => {
                        if (
                          status.data?.branch?.name === pr.head &&
                          recovery.handleError(e, {
                            operationLabel: "update",
                            detail: pr.base,
                            reappliedMessage: `Updated from ${pr.base} and reapplied your changes.`,
                            plainMessage: `Updated ${pr.head} from ${pr.base}`,
                            run: { op: "merge", ref: pr.base },
                          })
                        ) {
                          return;
                        }
                        toastError(e);
                      },
                    },
                  )
                }
              >
                <ArrowClockwiseIcon data-icon="inline-start" />
                Update branch
              </DisabledReasonButton>
            )}
            <DropdownMenu>
              {/* A natively-disabled Button swallows `title`, so the refusal
                  rides a wrapping span (house idiom) — outside the trigger,
                  which carries `disabled` itself so a blocked merge can't open
                  the menu. */}
              <span
                title={mergeReason}
                className={cn(
                  "inline-flex",
                  mergeBlocked && "cursor-not-allowed",
                )}
              >
                <DropdownMenuTrigger
                  disabled={mergeBlocked}
                  render={<Button size="sm" />}
                >
                  <GitMergeIcon data-icon="inline-start" />
                  Merge
                  <CaretDownIcon data-icon="inline-end" />
                </DropdownMenuTrigger>
              </span>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  disabled={
                    !isMergeMethodAllowed(rulesConfig, pr.base, "merge")
                  }
                  onClick={() => doMerge("merge")}
                >
                  Create a merge commit
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    !isMergeMethodAllowed(rulesConfig, pr.base, "squash")
                  }
                  onClick={() => doMerge("squash")}
                >
                  Squash and merge
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    !isMergeMethodAllowed(rulesConfig, pr.base, "rebase")
                  }
                  onClick={() => doMerge("rebase")}
                >
                  Rebase and merge
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {pr.status === "closed" && (
          <>
            <span className="flex-1" />
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={update.isPending}
              reason="Saving…"
              onClick={() => setStatus("open")}
              title={
                draftRidesStateChange
                  ? "Reopens and posts your draft as a comment"
                  : undefined
              }
            >
              <ArrowCounterClockwiseIcon data-icon="inline-start" />
              {draftRidesStateChange ? "Reopen with comment" : "Reopen"}
            </DisabledReasonButton>
          </>
        )}
      </div>

      <PromoteLocalPrDialog
        repoPath={repoPath}
        pr={pr}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={(open) => {
          // The dialog stays mounted, so cancel any in-flight generation on close.
          if (!open) prGen.cancel();
          edit.setOpen(open);
        }}
        title="Edit pull request"
        description="Updates the title and description of this local pull request."
        contentClassName={undefined}
        bodyTextareaClassName="max-h-72"
        onGenerate={aiEnabled ? runGenerate : undefined}
        generating={prGen.generating}
        generateDisabled={ahead.length === 0}
        belowBody={
          canLinkIssues ? (
            <LinkedIssuesField
              repoPath={repoPath}
              lens="origin"
              chips={linkedIssues}
              onToggleKeyword={toggleIssueKeyword}
              onRemove={removeIssue}
              onPick={pickIssue}
              disabled={prGen.generating}
            />
          ) : undefined
        }
        bodyActions={
          !aiEnabled ? undefined : prGen.generating ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={prGen.cancel}
            >
              <XIcon data-icon="inline-start" />
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={ahead.length === 0}
              onClick={runGenerate}
              // The chord is only offered while it would do something — a
              // disabled Generate's shortcut is dead too.
              title={
                ahead.length > 0
                  ? `Generate the title and description with AI${generateHint}`
                  : "Generate the title and description with AI"
              }
            >
              <SparkleIcon data-icon="inline-start" />
              Generate
            </Button>
          )
        }
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        description="Removes this comment from the local pull request. This cannot be undone."
        onConfirm={(commentId) => {
          deleteComment(commentId);
          setDeletingCommentId(null);
        }}
      />

      {recovery.dialog}
    </div>
  );
}
