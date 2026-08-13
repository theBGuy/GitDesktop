import { ArrowClockwiseIcon, PlayIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import {
  forgeFeatureReady,
  useForgeStatus,
  useRepoStatus,
  useRepoWriteAccess,
  writeAccessReason,
} from "@/lib/git/queries";
import { useWorkflowRuns } from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import { StatusIcon, statusLabel } from "./status";

export function ActionsPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const forge = useForgeStatus(repoPath);
  // CI reads are provider-neutral (GitHub Actions + GitLab pipelines): a ready
  // repo lists runs either way. Starting a run is a SHARED write — `canWrite ||
  // forgeFeatureReady` keeps GitHub's button up while forge-status is pending and
  // positively enables a ready GitLab repo (which runs a pipeline on a ref rather
  // than dispatching a workflow — the dialog adapts).
  const ghReady = forgeFeatureReady(forge.data, "ci");
  const provider = forge.data?.provider;
  const isGitLab = provider === "gitlab";
  // GitLab and Bitbucket both call CI "pipelines"; only GitHub says "workflow".
  const isPipelines = provider === "gitlab" || provider === "bitbucket";
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const canDispatch = canWrite || forgeFeatureReady(forge.data, "ciDispatch");
  // Starting a run is a repo write: an explicitly read-only viewer keeps the
  // control (with the reason) rather than losing it. CI is repo-wide, so the
  // probe takes no lens; an Activity-hidden tab still renders, so it also gates
  // on `active` to keep a background tab from fetching.
  const writeAccess = useRepoWriteAccess(
    repoPath,
    undefined,
    active && !!provider,
  );
  const writeReason = writeAccessReason(writeAccess.data);
  const writeBlocked = writeAccess.data?.canPush === false;
  const runNoun = isPipelines ? "pipeline" : "workflow";
  const runHint =
    writeReason ??
    (ghReady
      ? `Run a ${runNoun}`
      : isGitLab
        ? "Sign in with the GitLab CLI (glab) to run pipelines"
        : "Sign in with GitHub CLI to run workflows");
  const status = useRepoStatus(repoPath);
  const currentBranch = status.data?.branch.name ?? null;

  const [branchOnly, setBranchOnly] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [runOpen, setRunOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const runs = useWorkflowRuns(
    repoPath,
    ghReady,
    active,
    branchOnly && currentBranch ? currentBranch : undefined,
  );
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);

  useHotkeyAction("focus-filter", () => filterRef.current?.focus());

  const query = filterText.trim().toLowerCase();
  const allRuns = runs.data ?? [];
  const visible = allRuns.filter(
    (r) =>
      !query ||
      r.displayTitle.toLowerCase().includes(query) ||
      r.workflowName.toLowerCase().includes(query) ||
      r.headBranch.toLowerCase().includes(query),
  );

  const onListKeyDown = listKeyboardNav({
    items: visible,
    activeIndex: visible.findIndex((r) => r.id === selectedRunId),
    onActivate: (run) => selectRun(run.id),
    rowKey: (run) => String(run.id),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <DisabledReasonButton
          variant={branchOnly ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={branchOnly}
          disabled={!currentBranch}
          reason="No current branch"
          title={
            currentBranch ? `Show runs on ${currentBranch} only` : undefined
          }
          onClick={() => setBranchOnly((v) => !v)}
        >
          This branch
        </DisabledReasonButton>
        <div className="ml-auto flex items-center gap-1">
          {canDispatch && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={!ghReady || writeBlocked}
              reason={runHint}
              title={runHint}
              onClick={() => setRunOpen(true)}
            >
              <PlayIcon data-icon="inline-start" />
              Run {runNoun}…
            </DisabledReasonButton>
          )}
          <DisabledReasonButton
            variant="outline"
            size="icon-sm"
            aria-label="Refresh runs"
            disabled={!ghReady || runs.isFetching}
            reason={ghReady ? undefined : "Connect this repo to load runs"}
            title="Refresh runs"
            onClick={() => runs.refetch()}
          >
            <ArrowClockwiseIcon
              className={cn(runs.isFetching && "animate-spin")}
            />
          </DisabledReasonButton>
        </div>
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by title, workflow, or branch"
          className="h-7"
          autoComplete="off"
        />
      </div>

      {/* overflow-hidden: contain the list's natural height (the vendored Root
          is `relative`-only) so a long list can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {forge.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !ghReady ? (
          <ForgeNotReady
            repoPath={repoPath}
            feature={isPipelines ? "pipelines" : "workflow runs"}
          />
        ) : runs.isPending ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : runs.isError ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            Couldn't load {runNoun} runs. Refresh to try again.
          </p>
        ) : visible.length === 0 ? (
          allRuns.length > 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No runs match the filter.
            </p>
          ) : branchOnly ? (
            <div className="flex flex-col items-start gap-2 px-3 py-4">
              <p className="text-xs text-muted-foreground">
                No {runNoun} runs on this branch yet.
              </p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setBranchOnly(false)}
              >
                Show all branches
              </Button>
            </div>
          ) : (
            <Empty className="min-h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlayIcon />
                </EmptyMedia>
                <EmptyTitle>No {runNoun} runs yet</EmptyTitle>
                <EmptyDescription>
                  {isPipelines
                    ? isGitLab
                      ? "Pipelines run on pushes and merge requests — runs land here as they happen."
                      : "Pipelines run on pushes and pull requests — runs land here as they happen."
                    : "GitHub Actions workflows run on pushes and pull requests — runs land here as they happen."}
                </EmptyDescription>
              </EmptyHeader>
              {canDispatch && (
                <EmptyContent>
                  <DisabledReasonButton
                    variant="outline"
                    size="sm"
                    disabled={writeBlocked}
                    reason={writeReason}
                    onClick={() => setRunOpen(true)}
                  >
                    <PlayIcon data-icon="inline-start" />
                    Run {runNoun}…
                  </DisabledReasonButton>
                </EmptyContent>
              )}
            </Empty>
          )
        ) : (
          <div onKeyDown={onListKeyDown}>
            {visible.map((run) => {
              const active = run.id === selectedRunId;
              return (
                <button
                  type="button"
                  key={run.id}
                  data-row={String(run.id)}
                  className={cn(
                    "block w-full border-b px-3 py-2 text-left",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onClick={() => selectRun(run.id)}
                  onDoubleClick={() => run.url && openUrl(run.url)}
                >
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <StatusIcon
                      status={run.status}
                      conclusion={run.conclusion}
                      className="size-3.5"
                    />
                    <span className="truncate" title={run.displayTitle}>
                      {run.displayTitle}
                    </span>
                  </p>
                  <p className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground">
                    {run.workflowName} · {run.headBranch} ·{" "}
                    {statusLabel(run.status, run.conclusion)}
                    {run.updatedAt
                      ? ` · ${formatRelativeTime(run.updatedAt)}`
                      : ""}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <RunWorkflowDialog
        repoPath={repoPath}
        open={runOpen}
        onOpenChange={setRunOpen}
        defaultRef={currentBranch ?? ""}
      />
    </div>
  );
}
