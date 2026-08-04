import { ClockIcon } from "@phosphor-icons/react";
import { type ComponentProps, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import {
  DiffContent,
  type DiffLineAnchor,
  type LineWidget,
} from "@/features/diff/DiffSurfaceLazy";
import { FileRowActions } from "@/features/history/FileRowActions";
import { TimeTrackingControls } from "@/features/issues/RemoteIssueViewParts";
import {
  useAddMrSpentTime,
  useGlMrTimeStats,
  useSetMrTimeEstimate,
} from "@/lib/git/queries";
import type { ForgeProvider, ReviewThreadOut } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { DraftCommentCard } from "./PendingReviewBar";
import { ReviewThreadCard, type SuggestionApply } from "./ReviewThreads";

type PrFile = { path: string; additions: number; deletions: number };

/** The handlers/gates the in-diff {@link ReviewThreadCard}s need — a subset of
 *  the Conversation block's, passed straight through from the view. */
interface DiffThreadWiring {
  onQuote?: (body: string) => void;
  onReply?: (threadId: string, body: string) => Promise<void>;
  onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** The forge the threads came from — disambiguates bare-fence Apply scope for
   *  suggestions (GitHub = whole range, GitLab = anchored line only). Defaults to
   *  "github" in the card so an unwired caller is byte-identical. */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply shown (identical graceful default as the Conversation block). */
  apply?: SuggestionApply;
  /** File-section lookup for synthesizing a hunk on hunk-less providers, so the
   *  in-diff thread cards get the same Apply affordance. Absent = no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
}

/**
 * One anchor block: the review thread(s) on a single side+line, rendered as a
 * gap-2 stack of compact {@link ReviewThreadCard}s. Owns its own per-thread
 * expanded state (unresolved default-open, resolved default-closed) so each
 * card collapses independently, mirroring the Conversation block's defaults.
 */
function DiffThreadAnchor({
  threads,
  onQuote,
  onReply,
  onResolve,
  provider,
  apply,
  fileDiffLookup,
}: { threads: ReviewThreadOut[] } & DiffThreadWiring) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (t: ReviewThreadOut) => expanded[t.id] ?? !t.isResolved;
  return (
    <div className="flex flex-col gap-2">
      {threads.map((t) => (
        <ReviewThreadCard
          key={t.id}
          thread={t}
          compact
          expanded={isExpanded(t)}
          onToggleExpand={() =>
            setExpanded((prev) => ({
              ...prev,
              [t.id]: !(prev[t.id] ?? !t.isResolved),
            }))
          }
          onQuote={onQuote}
          onReply={onReply}
          onResolve={onResolve}
          provider={provider}
          apply={apply}
          fileDiffLookup={fileDiffLookup}
        />
      ))}
    </div>
  );
}

/** The "Files" sub-tab: a file list down the left, the selected file's diff on
 *  the right. Presentational — the parent owns the selection + diff query.
 *  Review threads anchored to the selected file render under their exact line. */
export function PrFilesPane({
  files,
  effectivePath,
  onSelectPath,
  fileDiff,
  isPending,
  isError,
  threads,
  drafts,
  repoPath,
  number,
  lineWidget,
  onQuote,
  onReply,
  onResolve,
  provider,
  apply,
  fileDiffLookup,
  blameRev,
}: {
  files: PrFile[];
  effectivePath: string | null;
  onSelectPath: (path: string) => void;
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  /** All PR review threads; the pane anchors those on the selected file. */
  threads?: ReviewThreadOut[];
  /** Pending-review drafts; those on the selected file render as anchored cards
   *  under their line (needs `repoPath`/`number` for the edit/delete writes). */
  drafts?: ReviewDraft[];
  repoPath?: string;
  number?: number;
  /** The inline line-comment composer, passed straight to the diff. Absent =
   *  a read-only diff (unchanged). */
  lineWidget?: LineWidget;
  /** PR head sha — pins the file-row Blame at the PR's tip. Omit to hide Blame. */
  blameRev?: string;
} & DiffThreadWiring) {
  // Arrow keys walk the file list, mirroring the app's other diff lists.
  const onFilesKeyDown = listKeyboardNav({
    items: files,
    activeIndex: files.findIndex((f) => f.path === effectivePath),
    onActivate: (file) => onSelectPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  // Anchors for the SELECTED file only: threads (with a known line, not outdated)
  // AND pending-review drafts on this path. Multiple items on the same side+line
  // collapse into ONE stacked anchor (the diff library keeps a single render per
  // side+line — last write wins — so threads + a draft here must share it).
  const lineAnchors = useMemo<DiffLineAnchor[]>(() => {
    if (!effectivePath) return [];
    const threadsBySideLine = new Map<string, ReviewThreadOut[]>();
    for (const t of threads ?? []) {
      if (t.path !== effectivePath || t.line <= 0 || t.isOutdated) continue;
      const side = t.side === "old" ? "old" : "new";
      const key = `${side}:${t.line}`;
      const bucket = threadsBySideLine.get(key);
      if (bucket) bucket.push(t);
      else threadsBySideLine.set(key, [t]);
    }
    const draftsBySideLine = new Map<string, ReviewDraft[]>();
    // Drafts only render when the store owner keys (repoPath/number) are present.
    if (repoPath !== undefined && number !== undefined) {
      for (const d of drafts ?? []) {
        if (d.path !== effectivePath || d.line <= 0) continue;
        const key = `${d.side}:${d.line}`;
        const bucket = draftsBySideLine.get(key);
        if (bucket) bucket.push(d);
        else draftsBySideLine.set(key, [d]);
      }
    }
    const keys = new Set([
      ...threadsBySideLine.keys(),
      ...draftsBySideLine.keys(),
    ]);
    return [...keys].map((key) => {
      const [side, line] = key.split(":");
      const threadGroup = threadsBySideLine.get(key) ?? [];
      const draftGroup = draftsBySideLine.get(key) ?? [];
      return {
        side: side as "old" | "new",
        line: Number(line),
        render: () => (
          <div className="flex flex-col gap-2">
            {threadGroup.length > 0 && (
              <DiffThreadAnchor
                threads={threadGroup}
                onQuote={onQuote}
                onReply={onReply}
                onResolve={onResolve}
                provider={provider}
                apply={apply}
                fileDiffLookup={fileDiffLookup}
              />
            )}
            {repoPath !== undefined &&
              number !== undefined &&
              draftGroup.map((d) => (
                <DraftCommentCard
                  key={d.id}
                  repoPath={repoPath}
                  number={number}
                  draft={d}
                />
              ))}
          </div>
        ),
      };
    });
  }, [
    effectivePath,
    threads,
    drafts,
    repoPath,
    number,
    onQuote,
    onReply,
    onResolve,
    provider,
    apply,
    fileDiffLookup,
  ]);

  const fileRows = files.map((file) => (
    <button
      type="button"
      key={file.path}
      data-path={file.path}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
        effectivePath === file.path
          ? "bg-accent text-accent-foreground"
          : "hover:bg-muted/60",
      )}
      onClick={() => onSelectPath(file.path)}
      title={file.path}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      <span className="shrink-0 tabular-nums">
        <span className="text-success">+{file.additions}</span>{" "}
        <span className="text-destructive">-{file.deletions}</span>
      </span>
    </button>
  ));

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        {/* overflow-hidden contains the list's natural height (vendored Root is
            `relative`-only) so a long file list can't leak a window scrollbar. */}
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          {repoPath !== undefined ? (
            <FileRowActions
              repoPath={repoPath}
              blameRev={blameRev}
              onKeyDown={onFilesKeyDown}
            >
              {fileRows}
            </FileRowActions>
          ) : (
            <div onKeyDown={onFilesKeyDown}>{fileRows}</div>
          )}
        </ScrollArea>
      </aside>
      <main className="min-w-0 flex-1">
        {effectivePath ? (
          <DiffContent
            filePath={effectivePath}
            data={fileDiff}
            isPending={isPending}
            isError={isError}
            lineAnchors={lineAnchors}
            lineWidget={lineWidget}
          />
        ) : (
          <DiffPlaceholder message="Select a file to see its changes" />
        )}
      </main>
    </div>
  );
}

/** Merge-confirm dialog. Presentational — the parent keeps the merge mutation
 *  (so its `busy` flag stays accurate) and passes `pending` + `onConfirm`. */
export function MergePrDialog({
  open,
  onClose,
  number,
  host,
  prNoun,
  headRefName,
  baseRefName,
  strategyLabel,
  deleteBranch,
  onDeleteBranchChange,
  headIsDefault,
  deletionBlocked,
  pending,
  onConfirm,
  auto = false,
  stackNotice,
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  /** "GitHub" / "GitLab" — where the merge happens. */
  host: string;
  /** "pull request" / "merge request". */
  prNoun: string;
  headRefName: string;
  baseRefName: string;
  strategyLabel: string;
  deleteBranch: boolean;
  onDeleteBranchChange: (v: boolean) => void;
  /** Head is the repo's default branch — every forge refuses to delete it, so
   *  the delete-branch option is hidden entirely. */
  headIsDefault: boolean;
  /** A branch rule blocks deleting the head — the option shows but is disabled. */
  deletionBlocked: boolean;
  pending: boolean;
  onConfirm: () => void;
  /** Arms merge-when-pipeline-succeeds instead of merging now (GitLab-only) —
   *  reframes the copy + confirm button; the delete-branch checkbox rides the arm. */
  auto?: boolean;
  /** Extra scope a stacked merge takes with it — a stacked merge is atomic and
   *  bottom-up, so the PRs below this one merge too. Absent = unstacked. */
  stackNotice?: string;
  /** Overrides the confirm button's label so a stacked merge can name how many
   *  PRs it lands. Absent = the strategy label, unchanged. */
  confirmLabel?: string;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {auto ? "Auto-merge" : "Merge"} {prNoun} #{number}?
          </DialogTitle>
          <DialogDescription>
            {auto ? (
              <>
                {strategyLabel} when the pipeline passes — merges{" "}
                <span className="font-mono break-all">{headRefName}</span> into{" "}
                <span className="font-mono break-all">{baseRefName}</span> on{" "}
                {host} once the running pipeline succeeds. This cannot be easily
                undone once it merges.
              </>
            ) : (
              <>
                {strategyLabel} — merges{" "}
                <span className="font-mono break-all">{headRefName}</span> into{" "}
                <span className="font-mono break-all">{baseRefName}</span> on{" "}
                {host}. This cannot be easily undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {/* A stacked merge lands more than the PR on screen — say so above the
            options, never only on the confirm button. */}
        {stackNotice && <p className="text-xs text-warning">{stackNotice}</p>}
        {/* Deleting the head after merge is offered only when it's actually
            possible: never for the default branch (hidden — the forge refuses),
            and disabled with a reason when a branch rule blocks its deletion. */}
        {!headIsDefault && (
          <label
            className={cn(
              "flex items-start gap-2 text-xs text-muted-foreground",
              deletionBlocked
                ? "cursor-not-allowed opacity-70"
                : "cursor-pointer",
            )}
          >
            <Checkbox
              checked={deleteBranch && !deletionBlocked}
              disabled={deletionBlocked}
              onCheckedChange={(checked) =>
                onDeleteBranchChange(checked === true)
              }
            />
            <span className="min-w-0">
              Delete <span className="font-mono break-all">{headRefName}</span>{" "}
              on the remote after merging
              {deletionBlocked && (
                <span className="text-warning">
                  {" "}
                  — protected by a branch rule
                </span>
              )}
            </span>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending && <Spinner data-icon="inline-start" />}
            {auto ? "Enable auto-merge" : (confirmLabel ?? strategyLabel)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The GitLab-only MR time-tracking summary for the header meta area: a compact
 * "Xh est · Ym spent" (zero parts omitted). For an OPEN MR it's a popover
 * trigger wrapping the same estimate/add-spent controls as the issue rail; for a
 * closed/merged MR it's a static line, and it renders nothing at all when there's
 * no time to show. GitHub is zero-diff — the caller only mounts this behind the
 * `timeTracking` flag.
 */
export function MrTimeTracking({
  repoPath,
  number,
  open,
}: {
  repoPath: string;
  number: number;
  /** Whether the MR is open — only then are the editing controls offered. */
  open: boolean;
}) {
  const stats = useGlMrTimeStats(repoPath, number);
  const setEstimate = useSetMrTimeEstimate(repoPath);
  const addSpent = useAddMrSpentTime(repoPath);
  const onError = (e: unknown) => toastError(e);

  const data = stats.data;
  const humanEstimate = data?.humanTimeEstimate ?? "";
  const humanSpent = data?.humanTotalTimeSpent ?? "";
  const hasAny =
    (data?.timeEstimate ?? 0) > 0 || (data?.totalTimeSpent ?? 0) > 0;

  // Nothing to show and the MR is closed → render nothing (GitHub also lands
  // here via `hasAny` staying false, but the caller already gates on the flag).
  if (!hasAny && !open) return null;

  const summary = (
    <span className="flex items-center gap-1">
      <ClockIcon className="size-3 shrink-0" aria-hidden />
      {hasAny
        ? [
            humanEstimate ? `${humanEstimate} est` : null,
            humanSpent ? `${humanSpent} spent` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Track time"}
    </span>
  );

  // Closed MR: a static, non-interactive summary.
  if (!open) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {summary}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            aria-label="Time tracking"
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-xs font-medium text-muted-foreground">
          Time tracking
        </p>
        {stats.isPending ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : (
          <TimeTrackingControls
            stats={data}
            editable
            pending={setEstimate.isPending || addSpent.isPending}
            idPrefix="mr"
            onSetEstimate={(duration) =>
              setEstimate.mutate({ number, duration }, { onError })
            }
            onAddSpent={(duration) =>
              addSpent.mutate({ number, duration }, { onError })
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
