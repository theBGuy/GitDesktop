import {
  CheckCircleIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { useWalkSelfHeal } from "@/features/repository/use-walk-self-heal";
import { PREFILTER_READ_REASON } from "@/lib/git/conflict-prefilter";
import {
  LOCAL_PR_WRITES_KEY,
  type LocalPrDiscardResult,
  type LocalPrUpdateDiscardVars,
  type LocalPrUpdateFinishVars,
  type LocalPrWriteKind,
  pendingWriteMatching,
  useAbortLocalPrMerge,
  useDiscardLocalPrUpdate,
  useFinishLocalPrMerge,
  useFinishLocalPrUpdate,
  usePendingRepoWrites,
  useRepoStatus,
} from "@/lib/git/queries";
import type { FileEntry } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import { type LocalPr, openPendingUpdate } from "@/lib/pulls/local";
import { localPrKey, useUpdateLocalPr } from "@/lib/pulls/queries";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

const baseName = (path: string) => path.split("/").pop() || path;

/** Local-PR wording: this throws away a paused MERGE into the user's own branch, not a
 *  remote-PR resolution — deliberately NOT shared with the remote surface's copy. */
const DISCARD_MERGE_CONFIRM = {
  title: "Discard this merge?",
  body: "The conflict resolution is thrown away; your branch and working tree are untouched.",
  confirmLabel: "Discard merge",
  confirmVariant: "destructive",
} as const;

/** The update's discard: nothing merges into the base, so the merge copy is false here. */
export const DISCARD_UPDATE_CONFIRM = {
  title: "Discard this update?",
  body: "The conflict resolution is thrown away; your branch and working tree are untouched.",
  confirmLabel: "Discard update",
  confirmVariant: "destructive",
} as const;

export const UPDATE_WORKTREE_UNREADABLE =
  "This update's worktree can't be read. Discard this update, then choose Resolve conflicts to start again.";

/** The one sentence a finished update toasts. `away` is `landedIn(repo).away`, placed
 *  inside the first sentence. */
export const updatedToast = (
  head: string,
  base: string,
  approvalCleared: boolean,
  away: string,
) =>
  `Updated ${head} from ${base}${away}` +
  (approvalCleared ? ". Approval cleared because the branch changed." : "");

/** A start that paused on conflicts. */
export const updateConflictsToast = (
  head: string,
  base: string,
  away: string,
) =>
  `Updating ${head} from ${base}${away} has conflicts — resolve them to finish`;

/** What a settled discard toasts: an update that had already landed reads as a finish. */
export const discardSettledToast = (
  result: LocalPrDiscardResult,
  head: string,
  base: string,
  away: string,
) =>
  result.status === "updated"
    ? updatedToast(head, base, result.approvalCleared, away)
    : `Update discarded${away}`;

type ResolveMode = "merge" | "update";

/** Each mode's words and the write kinds its busy state reads. The merge column is
 *  the into-base flow's copy, unchanged. */
const MODE_COPY: Record<
  ResolveMode,
  {
    heading: (head: string, base: string) => ReactNode;
    discardLabel: string;
    finishLabel: string;
    doneLine: (head: string, approved: boolean) => ReactNode;
    confirm: typeof DISCARD_MERGE_CONFIRM | typeof DISCARD_UPDATE_CONFIRM;
    finishKind: LocalPrWriteKind;
    discardKind: LocalPrWriteKind;
  }
> = {
  merge: {
    heading: (head, base) => (
      <>
        Resolving conflicts · <span className="font-mono">{head}</span> →{" "}
        <span className="font-mono">{base}</span>
      </>
    ),
    discardLabel: "Abort",
    finishLabel: "Finish merge",
    doneLine: () => "All conflicts resolved — Finish to complete the merge.",
    confirm: DISCARD_MERGE_CONFIRM,
    finishKind: "finish-merge",
    discardKind: "abort-merge",
  },
  update: {
    heading: (head, base) => (
      <>
        Merging <span className="font-mono">{base}</span> into{" "}
        <span className="font-mono">{head}</span>. Finishing updates{" "}
        <span className="font-mono">{head}</span>.
      </>
    ),
    discardLabel: "Discard",
    finishLabel: "Finish update",
    doneLine: (head, approved) => (
      <>
        All conflicts resolved. Finish update to apply the merge to{" "}
        <span className="font-mono">{head}</span>
        {approved ? "; this clears the PR's approval." : "."}
      </>
    ),
    confirm: DISCARD_UPDATE_CONFIRM,
    finishKind: "finish-update",
    discardKind: "discard-update",
  },
};

/** The header sentence's box and icon: the update sentence wraps, aligned to its first
 *  line, since it is the only on-screen statement that finishing moves the user's
 *  branch; the merge one keeps its single truncated line. */
const HEADING_CLASS: Record<
  ResolveMode,
  { box: string; icon: string; text: string }
> = {
  merge: {
    box: "flex min-w-0 items-center gap-1.5 text-warning",
    icon: "size-3.5 shrink-0",
    text: "min-w-0 truncate",
  },
  update: {
    box: "flex min-w-0 items-start gap-1.5 text-warning",
    icon: "mt-px size-3.5 shrink-0",
    text: "min-w-0",
  },
};

/**
 * The isolated-worktree conflict-resolution surface for a local PR, in two modes.
 * `merge`: a paused merge of head INTO the base (`pr.pendingMerge`); Finish commits and
 * advances the base, Abort throws the worktree away. `update`: a paused merge of the
 * base INTO head (`openPendingUpdate(pr)`); Finish update moves head and the PR stays
 * open, Discard throws the worktree away, Back to PR returns without discarding.
 * Either way the user's branch and working tree are untouched until Finish.
 *
 * The conflict machinery is `repoPath`-parameterized, so `ConflictFileView` /
 * `ConflictResolveView` and `useRepoStatus` just take the worktree path. Both modes
 * share ONE `onFinish` and ONE `onAbort`.
 */
export function ResolveConflictsView({
  repoPath,
  pr,
  mode,
  finishHeldReason,
  onBack,
  onHeadMoved,
}: {
  repoPath: string;
  pr: LocalPr;
  mode: ResolveMode;
  /** Holds Finish with this reason (update mode: a dirty checked-out head). */
  finishHeldReason?: string;
  /** Back to PR (update mode): leaves the editor, discarding nothing. */
  onBack?: () => void;
  /** Called the moment an update has moved head, so the host can hold its strip
   *  until its own reads answer for the new tip. `base` and `head` are the PR's
   *  own, the names those reads are keyed on. */
  onHeadMoved?: (target: {
    repo: string;
    id: string;
    base: string;
    head: string;
  }) => void;
}) {
  const merge = pr.pendingMerge;
  const update = openPendingUpdate(pr);
  const pending = mode === "merge" ? merge : update;
  const copy = MODE_COPY[mode];
  const worktreePath = pending?.worktreePath ?? "";
  const status = useRepoStatus(worktreePath);
  const updateRecord = useUpdateLocalPr(repoPath);
  const finish = useFinishLocalPrMerge(repoPath);
  const abort = useAbortLocalPrMerge(repoPath);
  const finishUpdate = useFinishLocalPrUpdate(repoPath, localPrKey(repoPath));
  const discardUpdate = useDiscardLocalPrUpdate(repoPath, localPrKey(repoPath));
  // This worktree's own finish/discard, matched on its worktree from the cache: the
  // host view swaps local PRs without remounting this surface, and two local PRs
  // can each hold a paused merge or update.
  const localPrWrites = usePendingRepoWrites(LOCAL_PR_WRITES_KEY[0], repoPath);
  const onThisWorktree = (v: { worktreePath?: unknown }) =>
    v.worktreePath === worktreePath;
  const onThisUpdate = (
    v: Pick<LocalPrUpdateFinishVars, "worktreePath"> &
      Pick<LocalPrUpdateDiscardVars, "worktreePath">,
  ) => v.worktreePath === worktreePath;
  const writeOnThisTree = (kind: LocalPrWriteKind) =>
    mode === "update"
      ? pendingWriteMatching(localPrWrites, kind, onThisUpdate)
      : pendingWriteMatching(localPrWrites, kind, onThisWorktree);
  const finishing = writeOnThisTree(copy.finishKind) !== undefined;
  const aborting = writeOnThisTree(copy.discardKind) !== undefined;
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  // Same AI-resolution store the Changes tab drives: `activePath` decides whether
  // the selected file shows the AI streaming view or the manual editor, and
  // `startAll` kicks off a "resolve all" walk. The walk is scoped to the tree it
  // started in (`scopePath`), so surfaces of any other tree ignore it and it
  // survives a tab peek; a repo switch still clears it.
  const startAll = useConflictResolve((s) => s.startAll);
  const activePath = useConflictResolve((s) => s.activePath);
  const scopePath = useConflictResolve((s) => s.scopePath);
  const retireWalk = useConflictResolve((s) => s.retire);
  const prefilterHold = useConflictResolve(
    (s) => s.prefiltering === worktreePath,
  );
  // Only this worktree's walk drives this surface.
  const walkActive = scopePath === worktreePath ? activePath : null;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // A user file pick, noted first so a pending continuation (a markdown
  // `#N` lookup) strands; the automatic selections stay silent.
  const pickPath = (path: string) => {
    useUiStore.getState().noteUserInteraction();
    setSelectedPath(path);
  };

  // Arming happens at or after mount, so a walk already scoped to this worktree is
  // left over from an earlier visit — clear it, or re-entering a still-living
  // worktree would resume a stale run. Keyed on the path (not a bare once-flag) so
  // `<Activity>` show replays no-op and a peeked walk keeps its place, while a real
  // re-entry re-arms. A discarded worktree's walk needs no disarm: its path carries
  // a fresh uuid (`gd-resolve-<uuid>`) that never comes back.
  const initedFor = useRef<string | null>(null);
  useEffect(() => {
    if (initedFor.current === worktreePath) return;
    initedFor.current = worktreePath;
    const walk = useConflictResolve.getState();
    if (walk.scopePath === worktreePath) walk.stop();
  }, [worktreePath]);

  const entries = status.data?.entries ?? [];
  const conflicted: FileEntry[] = entries.filter(
    (e) => e.unstaged === "conflicted" || e.staged === "conflicted",
  );
  const conflictedPaths = conflicted.map((e) => e.path);
  useWalkSelfHeal(
    worktreePath,
    status.data && !status.isPlaceholderData ? conflictedPaths : null,
  );

  // Keep a valid selection: default to the first conflict, and drop it once that
  // file is resolved (leaves the list). Following `walkActive` lets an AI
  // "resolve all" run visibly walk the list as each file completes. Keyed on
  // `status.data` (the source of `conflicted`) so it re-runs as files resolve.
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from status.data
  useEffect(() => {
    const paths = conflicted.map((e) => e.path);
    if (walkActive && paths.includes(walkActive)) {
      setSelectedPath(walkActive);
      return;
    }
    setSelectedPath((cur) => {
      if (cur && paths.includes(cur)) return cur;
      return paths[0] ?? null;
    });
  }, [walkActive, status.data]);

  const remaining = conflictedPaths.length;
  // Gated on a SUCCESSFUL read: an errored status query (a worktree that vanished
  // underneath us) leaves no entries, which would otherwise read as "all resolved".
  const done = status.isSuccess && remaining === 0;
  // Update mode only: a worktree that can't be read says so, and Finish waits for a
  // successful read (a pending or retrying one could still list conflicts).
  const unreadable = mode === "update" && status.isError;
  const statusSettling = mode === "update" && !status.isSuccess && !unreadable;

  // The conflict pane's landing, outside it: each pane hands focus here as it
  // unmounts, and focus on <body> lands here when the all-resolved line swaps in.
  const paneSinkRef = useRef<HTMLSpanElement>(null);
  useFocusOnControlsSwap(done, paneSinkRef);

  if (!pending) return null;

  const canResolveWithAi = aiEnabled && reviewConfigured && remaining > 0;
  const busy = finishing || aborting;
  // The record's head, which a branch rename rewrites (never the update field), is
  // the branch Finish moves; the base is the one the update merged.
  const headingHead = pr.head;
  const headingBase = mode === "update" && update ? update.base : pr.base;
  const doneLine = copy.doneLine(headingHead, pr.approved);
  const unreadableLine = (
    <div className="p-3 text-xs text-muted-foreground">
      {UPDATE_WORKTREE_UNREADABLE}
    </div>
  );

  // Awaited, not per-call callbacks: this surface unmounts the moment its record
  // field clears or the repo tab changes, and react-query drops per-call callbacks
  // once the observer has no listeners — the PR record would keep pointing at a
  // worktree the merge already finished with or threw away.
  async function onFinish() {
    if (!pending) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    retireWalk(pending.worktreePath);
    try {
      if (mode === "update" && update) {
        // The base the START merged, never the PR's live one: a retargeted PR would
        // otherwise get a commit subject naming a branch it did not merge.
        const started = {
          repo: repoPath,
          id: pr.id,
          head: pr.head,
          base: update.base,
        };
        const result = await finishUpdate.mutateAsync({
          id: started.id,
          base: started.base,
          head: started.head,
          worktreePath: update.worktreePath,
          worktreeId: update.worktreeId,
          opId: update.opId,
          journalRepo: update.journalRepo,
        });
        onHeadMoved?.({ ...started, base: pr.base });
        toast.success(
          updatedToast(
            started.head,
            started.base,
            result.approvalCleared,
            landedIn(started.repo).away,
          ),
        );
        return;
      }
      if (!merge) return;
      const outcome = await finish.mutateAsync({
        base: pr.base,
        strategy: merge.strategy,
        message: merge.message,
        worktreePath: merge.worktreePath,
        worktreeId: merge.worktreeId,
        opId: merge.opId,
      });
      if (outcome.status === "merged") {
        // Awaited ahead of its toast: a store write can reject (a concurrent
        // MCP writer, a locked store), and a `pendingMerge` left behind points
        // this surface at a worktree the merge has already consumed.
        await updateRecord.mutateAsync({
          id: pr.id,
          mutate: (cur) => ({
            ...cur,
            status: "merged",
            mergedAt: new Date().toISOString(),
            pendingMerge: undefined,
          }),
        });
        toast.success(`Merged ${pr.head} into ${pr.base}`);
        return;
      }
      // A multi-step rebase re-paused on the next commit's conflicts, still
      // in the same worktree. Leave `pendingMerge` untouched — the live
      // worktree status already drives this surface.
      toast("More conflicts to resolve");
    } catch (e) {
      toastError(e);
    }
  }

  async function onAbort() {
    if (!pending) return;
    if (!(await useConfirm.getState().ask(copy.confirm))) return;
    retireWalk(pending.worktreePath);
    try {
      if (mode === "update" && update) {
        const target = {
          repo: repoPath,
          id: pr.id,
          head: pr.head,
          base: update.base,
        };
        const result = await discardUpdate.mutateAsync({
          id: target.id,
          head: target.head,
          worktreePath: update.worktreePath,
          worktreeId: update.worktreeId,
          opId: update.opId,
          journalRepo: update.journalRepo,
        });
        if (result.status === "updated")
          onHeadMoved?.({ ...target, base: pr.base });
        toast.success(
          discardSettledToast(
            result,
            target.head,
            target.base,
            landedIn(target.repo).away,
          ),
        );
        return;
      }
      if (!merge) return;
      await abort.mutateAsync({
        worktreePath: merge.worktreePath,
        opId: merge.opId,
      });
      // Same ordering as Finish: the worktree is already gone, so a record
      // still naming it must surface as an error rather than a success toast.
      await updateRecord.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({ ...cur, pendingMerge: undefined }),
      });
      toast.success("Merge discarded");
    } catch (e) {
      toastError(e);
    }
  }

  const activeIndex = selectedPath ? conflictedPaths.indexOf(selectedPath) : -1;
  const onListKeyDown = listKeyboardNav({
    items: conflicted,
    activeIndex,
    rowKey: (e) => e.path,
    onActivate: (entry) => pickPath(entry.path),
  });
  const headingClass = HEADING_CLASS[mode];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: warning tone naming the merge and its direction, with Back to PR
          (update mode), the batch AI action, Abort or Discard, and Finish (held
          until every conflict is resolved and the worktree reads). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b px-3 py-2 text-xs">
        <span className={headingClass.box}>
          <WarningIcon className={headingClass.icon} />
          <span className={headingClass.text}>
            {copy.heading(headingHead, headingBase)}
          </span>
        </span>
        {/* At the pane's floor the buttons wrap within their group,
            right-aligned, so Finish never leaves the row; ml-auto keeps the
            group at the right edge when it drops to a line of its own. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {onBack && (
            <Button variant="ghost" size="xs" onClick={onBack}>
              Back to PR
            </Button>
          )}
          {canResolveWithAi && (
            <DisabledReasonButton
              size="xs"
              variant="ghost"
              disabled={prefilterHold}
              reason={prefilterHold ? PREFILTER_READ_REASON : undefined}
              onClick={() => startAll(conflictedPaths, worktreePath)}
            >
              {prefilterHold ? (
                <Spinner aria-hidden data-icon="inline-start" />
              ) : (
                <SparkleIcon data-icon="inline-start" />
              )}
              {remaining === 1 ? "Resolve with AI" : "Resolve all with AI"}
            </DisabledReasonButton>
          )}
          <DisabledReasonButton
            variant="outline"
            size="xs"
            disabled={busy}
            reason={busy ? ACT_PENDING_REASON : undefined}
            onClick={() => void onAbort()}
          >
            {copy.discardLabel}
          </DisabledReasonButton>
          <DisabledReasonButton
            size="xs"
            disabled={
              busy ||
              unreadable ||
              remaining > 0 ||
              statusSettling ||
              finishHeldReason !== undefined
            }
            reason={(() => {
              switch (true) {
                case busy:
                  return ACT_PENDING_REASON;
                case unreadable:
                  return UPDATE_WORKTREE_UNREADABLE;
                case remaining > 0 || statusSettling:
                  return "Resolve every conflict first";
                default:
                  return finishHeldReason;
              }
            })()}
            onClick={() => void onFinish()}
          >
            {/* The label carries the state; an unhidden spinner would name the
                button "Loading Finish …". */}
            {finishing && <Spinner aria-hidden data-icon="inline-start" />}
            {copy.finishLabel}
          </DisabledReasonButton>
        </div>
      </div>

      {/* Body: conflicted-file list + the selected file's conflict editor. */}
      <div className="flex min-h-0 flex-1">
        <div
          className="w-64 shrink-0 overflow-y-auto border-r"
          onKeyDown={onListKeyDown}
          role="listbox"
          aria-label="Conflicted files"
        >
          {(() => {
            switch (true) {
              case unreadable:
                return unreadableLine;
              case done:
                return (
                  <div className="flex items-start gap-1.5 p-3 text-xs text-muted-foreground">
                    <CheckCircleIcon className="mt-px size-3.5 shrink-0 text-success" />
                    <span>{doneLine}</span>
                  </div>
                );
              default:
                return conflicted.map((entry) => {
                  const active = entry.path === selectedPath;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      data-row={entry.path}
                      role="option"
                      aria-selected={active}
                      onClick={() => pickPath(entry.path)}
                      className={cn(
                        "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs outline-none",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60 focus-visible:bg-muted/60",
                      )}
                      title={entry.path}
                    >
                      <WarningIcon className="size-3.5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1 truncate">
                        {baseName(entry.path)}
                      </span>
                    </button>
                  );
                });
            }
          })()}
        </div>
        <div className="min-h-0 flex-1">
          <span ref={paneSinkRef} tabIndex={-1} className="sr-only" />
          {(() => {
            switch (true) {
              case unreadable:
                return unreadableLine;
              case done:
                return (
                  <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                    {doneLine}
                  </div>
                );
              case selectedPath === null:
                return null;
              case walkActive === selectedPath:
                return (
                  <ConflictResolveView
                    key={selectedPath}
                    repoPath={worktreePath}
                    path={selectedPath}
                    focusSink={paneSinkRef}
                  />
                );
              default:
                return (
                  <ConflictFileView
                    key={selectedPath}
                    repoPath={worktreePath}
                    path={selectedPath}
                    focusSink={paneSinkRef}
                  />
                );
            }
          })()}
        </div>
      </div>
    </div>
  );
}
