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
import { DiffContent, type DiffLineAnchor } from "@/features/diff/DiffSurface";
import { TimeTrackingControls } from "@/features/issues/RemoteIssueViewParts";
import {
  useAddMrSpentTime,
  useGlMrTimeStats,
  useSetMrTimeEstimate,
} from "@/lib/git/queries";
import type { ReviewThreadOut } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ReviewThreadCard, type SuggestionApply } from "./ReviewThreads";

type PrFile = { path: string; additions: number; deletions: number };

/** The handlers/gates the in-diff {@link ReviewThreadCard}s need — a subset of
 *  the Conversation block's, passed straight through from the view. */
interface DiffThreadWiring {
  onQuote?: (body: string) => void;
  onReply?: (threadId: string, body: string) => Promise<void>;
  onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply shown (identical graceful default as the Conversation block). */
  apply?: SuggestionApply;
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
  apply,
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
          apply={apply}
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
  onQuote,
  onReply,
  onResolve,
  apply,
}: {
  files: PrFile[];
  effectivePath: string | null;
  onSelectPath: (path: string) => void;
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  /** All PR review threads; the pane anchors those on the selected file. */
  threads?: ReviewThreadOut[];
} & DiffThreadWiring) {
  // Arrow keys walk the file list, mirroring the app's other diff lists.
  const onFilesKeyDown = listKeyboardNav({
    items: files,
    activeIndex: files.findIndex((f) => f.path === effectivePath),
    onActivate: (file) => onSelectPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  // Anchors for the SELECTED file only: threads with a known line on this path
  // that aren't outdated (outdated/line-0 threads live in the Conversation tab).
  // Multiple threads on the same side+line collapse into one stacked anchor.
  const lineAnchors = useMemo<DiffLineAnchor[]>(() => {
    if (!effectivePath || !threads) return [];
    const bySideLine = new Map<string, ReviewThreadOut[]>();
    for (const t of threads) {
      if (t.path !== effectivePath || t.line <= 0 || t.isOutdated) continue;
      const side = t.side === "old" ? "old" : "new";
      const key = `${side}:${t.line}`;
      const bucket = bySideLine.get(key);
      if (bucket) bucket.push(t);
      else bySideLine.set(key, [t]);
    }
    return [...bySideLine.entries()].map(([key, group]) => {
      const [side, line] = key.split(":");
      return {
        side: side as "old" | "new",
        line: Number(line),
        render: () => (
          <DiffThreadAnchor
            threads={group}
            onQuote={onQuote}
            onReply={onReply}
            onResolve={onResolve}
            apply={apply}
          />
        ),
      };
    });
  }, [effectivePath, threads, onQuote, onReply, onResolve, apply]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <ScrollArea className="min-h-0 flex-1">
          <div onKeyDown={onFilesKeyDown}>
            {files.map((file) => (
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
                <span className="min-w-0 flex-1 truncate font-mono">
                  {file.path}
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className="text-success">+{file.additions}</span>{" "}
                  <span className="text-destructive">-{file.deletions}</span>
                </span>
              </button>
            ))}
          </div>
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
  pending,
  onConfirm,
  auto = false,
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
  pending: boolean;
  onConfirm: () => void;
  /** Arms merge-when-pipeline-succeeds instead of merging now (GitLab-only) —
   *  reframes the copy + confirm button; the delete-branch checkbox rides the arm. */
  auto?: boolean;
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
                <span className="font-mono">{headRefName}</span> into{" "}
                <span className="font-mono">{baseRefName}</span> on {host} once
                the running pipeline succeeds. This cannot be easily undone once
                it merges.
              </>
            ) : (
              <>
                {strategyLabel} — merges{" "}
                <span className="font-mono">{headRefName}</span> into{" "}
                <span className="font-mono">{baseRefName}</span> on {host}. This
                cannot be easily undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={deleteBranch}
            onCheckedChange={(checked) =>
              onDeleteBranchChange(checked === true)
            }
          />
          Delete <span className="font-mono">{headRefName}</span> on the remote
          after merging
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending && <Spinner data-icon="inline-start" />}
            {auto ? "Enable auto-merge" : strategyLabel}
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
