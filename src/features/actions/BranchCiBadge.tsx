import {
  forgeFeatureReady,
  useForgeStatus,
  useRemoteBranches,
  useRepoStatus,
} from "@/lib/git/queries";
import { useLatestRun } from "@/lib/github/actions";
import { useUiStore } from "@/lib/stores/ui";
import { StatusIcon, statusLabel } from "./status";

/**
 * Glanceable CI status for the current branch's latest run, in the repo header.
 * Renders no badge until gh is ready and a run exists; clicking jumps to the
 * Actions tab with that run selected. While this branch's answer loads, a repo
 * whose last check found runs keeps an empty icon-wide slot, so the badge's
 * arrival doesn't squeeze the branch name.
 */
export function BranchCiBadge({ repoPath }: { repoPath: string }) {
  const gh = useForgeStatus(repoPath);
  // Renders for any provider with CI read implemented — GitHub Actions or GitLab
  // pipelines; useLatestRun routes through the provider-neutral forge_ci_run_list.
  const ciReady = forgeFeatureReady(gh.data, "ci");
  const status = useRepoStatus(repoPath);
  const branch = status.data?.branch.name ?? null;
  const latest = useLatestRun(repoPath, ciReady, branch);
  // Disabled observer: reads the list the shell warm-up cached, never fetches.
  const remoteBranches = useRemoteBranches(repoPath, false);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const selectRun = useUiStore((s) => s.selectRun);

  // Under a placeholder the data is another branch's run: it only decides
  // whether to reserve, never what renders. Runs are listed by branch name, so
  // the slot is held only for a branch that exists on a remote (an upstream, or
  // a same-named branch in the cached remote list), while the fetch will still
  // run (forge ready or resolving); it holds while the read is parked offline.
  if (latest.isPlaceholderData) {
    const onRemote =
      Boolean(status.data?.branch.upstream) ||
      (remoteBranches.data?.some((b) => b.name === branch) ?? false);
    const reserve =
      latest.data != null &&
      branch !== null &&
      onRemote &&
      (ciReady || gh.isPending);
    return reserve ? <span aria-hidden className="w-6.5 shrink-0" /> : null;
  }
  const run = latest.data;
  if (!run) return null;

  return (
    <button
      type="button"
      // Header shrink cascade: in a wide header this badge (shrink-20) shrinks
      // at five times the branch label's rate (shrink-4), weighted by width,
      // until it reaches an icon-wide floor (padding + the size-3.5 icon), with
      // the name truncating inside it; in a compact one the name is hidden and
      // the automatic minimum is that same floor. The title keeps the meaning.
      className="flex shrink-20 items-center @4xl/repo-header:min-w-6.5 gap-1.5 rounded-none px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
      <span className="hidden min-w-0 max-w-32 truncate @4xl/repo-header:inline">
        {run.workflowName}
      </span>
    </button>
  );
}
