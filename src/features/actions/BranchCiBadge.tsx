import {
  forgeFeatureReady,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import { useLatestRun } from "@/lib/github/actions";
import { useUiStore } from "@/lib/stores/ui";
import { StatusIcon, statusLabel } from "./status";

/**
 * Glanceable CI status for the current branch's latest run, in the repo header.
 * Renders nothing until gh is ready and a run exists; clicking jumps to the
 * Actions tab with that run selected.
 */
export function BranchCiBadge({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  // Renders for any provider with CI read implemented — GitHub Actions or GitLab
  // pipelines; useLatestRun routes through the provider-neutral forge_ci_run_list.
  const ciReady = forgeFeatureReady(gh.data, "ci");
  const status = useRepoStatus(repoPath);
  const branch = status.data?.branch.name ?? null;
  const latest = useLatestRun(repoPath, ciReady, branch);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const selectRun = useUiStore((s) => s.selectRun);

  const run = latest.data;
  if (!run) return null;

  return (
    <button
      type="button"
      // Middle tier of the header shrink cascade (branch 20 → badge 4 → repo 1):
      // under space pressure the workflow name compresses after the branch label
      // but before the repo name; the icon + title tooltip keep the meaning.
      className="flex min-w-0 shrink-4 items-center gap-1.5 rounded-none px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      title={`${run.workflowName}: ${statusLabel(run.status, run.conclusion)} — view in Actions`}
      onClick={() => {
        selectRun(run.id);
        setRepoTab("actions");
      }}
    >
      <StatusIcon
        status={run.status}
        conclusion={run.conclusion}
        className="size-3.5"
      />
      <span className="hidden min-w-0 max-w-32 truncate sm:inline">
        {run.workflowName}
      </span>
    </button>
  );
}
