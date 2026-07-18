import {
  ArrowLeftIcon,
  CaretRightIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import type { WorkflowRun } from "@/lib/github/actions";
import { CiStatusChip } from "../components/chips";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states";
import { timeAgo } from "../lib/format";
import { useCiRun, useCiRuns } from "../lib/queries";
import { navigate } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** The CI run list. `active` gates polling. */
export function CiBody({ active }: { active: boolean }) {
  const { data, isPending, isError, error, refetch } = useCiRuns(active);
  const { register, onKeyDown } = useRovingList();

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isPending || !data) return <SkeletonRows />;
  if (data.length === 0) {
    return (
      <EmptyState
        title="No CI runs."
        hint="Workflow runs for this repository will show up here."
      />
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {data.map((run, i) => (
        <li key={run.id}>
          <button
            type="button"
            ref={register(i)}
            onKeyDown={onKeyDown}
            onClick={() => navigate(`#ci/${run.id}`)}
            className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
          >
            <CiRow run={run} />
            <CaretRightIcon
              size={16}
              className="shrink-0 text-muted-foreground"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

function CiRow({ run }: { run: WorkflowRun }) {
  const when = run.updatedAt || run.createdAt;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <CiStatusChip status={run.status} conclusion={run.conclusion} />
      </div>
      <p className="mt-1 truncate text-sm font-medium text-foreground">
        {run.workflowName || run.displayTitle || "Workflow run"}
      </p>
      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
        <GitBranchIcon size={12} className="shrink-0" />
        <span className="truncate">{run.headBranch}</span>
        {when ? <span>· {timeAgo(when)}</span> : null}
      </p>
    </div>
  );
}

/** A read-only CI run detail with its jobs. */
export function CiDetail({ id }: { id: number }) {
  const { data, isPending, isError, error, refetch } = useCiRun(id);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate("#ci")}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          CI
        </button>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={3} />
      ) : (
        <article className="flex flex-col gap-4 px-4 py-5">
          <header className="flex flex-col gap-2">
            <CiStatusChip status={data.status} conclusion={data.conclusion} />
            <h1 className="text-base font-semibold text-foreground">
              {data.workflowName || data.displayTitle || "Workflow run"}
            </h1>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranchIcon size={12} />
              {data.headBranch}
              {data.event ? ` · ${data.event}` : ""}
            </p>
          </header>

          <section className="flex flex-col gap-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Jobs
            </p>
            {data.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs reported.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {data.jobs.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {job.name}
                    </span>
                    <CiStatusChip
                      status={job.status}
                      conclusion={job.conclusion}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </article>
      )}
    </div>
  );
}
