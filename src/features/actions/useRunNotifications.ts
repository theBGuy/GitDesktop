import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import {
  forgeFeatureReady,
  useForgeStatus,
  useRemoteBranches,
  useRepoIdentity,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  isRunActive,
  runNotifyOptions,
  type WorkflowRun,
} from "@/lib/github/actions";
import { emitNotification } from "@/lib/notifications/emit";
import { anyChannelOn } from "@/lib/notifications/overrides";
import {
  useNotificationOverrides,
  useRepoNotificationOverride,
} from "@/lib/notifications/queries";
import { useSettings } from "@/lib/settings/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
import {
  acceptsAsPrime,
  primeFrom,
  type RunNotifyPrime,
  runsToNotify,
} from "./run-notify-diff";
import { statusLabel } from "./status";

/** The branch the run poll and the header badge key on: the checked-out one. */
export function useRunNotifyBranch(repoPath: string): string | null {
  return useRepoStatus(repoPath).data?.branch.name ?? null;
}

/**
 * Whether run notifications deliver for this repo on any channel — undefined while
 * settings, the override store or the repo's identity (which keys its override)
 * are unresolved. A failed override read counts as resolved with no override; a
 * failed identity read counts as resolved too, falling back to the raw-path
 * override (`identity ?? repoPath`).
 */
export function useRunNotifyEnabled(repoPath: string): boolean | undefined {
  const settings = useSettings();
  const overrides = useNotificationOverrides();
  const identity = useRepoIdentity(repoPath);
  const override = useRepoNotificationOverride(repoPath);
  if (
    settings.data === undefined ||
    (overrides.data === undefined && !overrides.isError) ||
    (identity.data === undefined && !identity.isError)
  )
    return undefined;
  return anyChannelOn(settings.data.notifications, override, ["actionRuns"]);
}

/**
 * Whether `branch` exists on a remote — an upstream, or a same-named branch in the
 * remote list the shell warm-up cached. Runs are listed by branch name, so neither
 * the run poll nor the badge fetches without it. A branch pushed without tracking
 * whose remote list isn't cached yet reads false until the list lands.
 */
export function useBranchOnRemote(
  repoPath: string,
  branch: string | null,
): boolean {
  const status = useRepoStatus(repoPath);
  // Disabled observer: reads the list the shell warm-up cached, never fetches.
  const remoteBranches = useRemoteBranches(repoPath, false);
  return (
    branch !== null &&
    (Boolean(status.data?.branch.upstream) ||
      (remoteBranches.data?.some((b) => b.name === branch) ?? false))
  );
}

/**
 * Background poller for OS notifications on the current branch's workflow runs:
 * every 45s (8s while a run is active, also while unfocused) it snapshots recent
 * runs and notifies on each run that completed since the last poll. The first
 * poll fetched after it enables for a repo and branch only primes the snapshot. It
 * is the one interval owner of the shared runs read the header badge also renders.
 */
export function useRunNotifications(repoPath: string) {
  const gh = useForgeStatus(repoPath);
  const branch = useRunNotifyBranch(repoPath);
  const onRemote = useBranchOnRemote(repoPath, branch);
  const notifyEnabled = useRunNotifyEnabled(repoPath);
  // Polled for any provider whose CI read is built — GitHub Actions and GitLab
  // pipelines both map onto the same neutral run shape the diff reads. Delivery
  // stays correct regardless — emit re-reads the override itself.
  const enabled =
    repoPath !== "" &&
    forgeFeatureReady(gh.data, "ci") &&
    onRemote &&
    notifyEnabled === true;

  const poll = useQuery({
    ...runNotifyOptions(repoPath, branch),
    enabled,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => isRunActive(r.status))
        ? 8_000
        : 45_000,
    refetchIntervalInBackground: true,
  });

  // The prime resets when the repo or branch changes, so a switch never fires a
  // backlog of "finished" runs, and survives a disable, so a witnessed edge still
  // announces after a mute. `enabledAt` is captured when the notifier enables
  // with no prime: only a poll fetched after it may prime (`acceptsAsPrime`).
  const key = `${repoPath}:${branch}`;
  const prime = useRef<RunNotifyPrime<WorkflowRun> | null>(null);
  const watch = useRef<{ key: string; enabledAt: number | null }>({
    key,
    enabledAt: null,
  });
  // Declared before the data effect, so a cached snapshot arriving in the same
  // commit is already judged against this enable.
  useEffect(() => {
    if (watch.current.key !== key) {
      watch.current = { key, enabledAt: null };
      prime.current = null;
    }
    if (prime.current !== null) return;
    watch.current.enabledAt = enabled ? Date.now() : null;
  }, [enabled, key]);

  const diff = useEffectEvent((runs: WorkflowRun[], fetchedAt: number) => {
    if (watch.current.key !== key) return;
    const before = prime.current;
    if (before === null && !acceptsAsPrime(watch.current.enabledAt, fetchedAt))
      return;
    prime.current = primeFrom(runs, fetchedAt);
    for (const run of runsToNotify(before, runs, fetchedAt)) {
      const ok = run.conclusion === "success";
      const title = `${run.workflowName} ${statusLabel(run.status, run.conclusion).toLowerCase()} on ${run.headBranch}`;
      emitNotification({
        source: "actionRuns",
        outcome: ok ? "success" : "failure",
        row: {
          kind: "ci-run",
          tone: ok ? "success" : "danger",
          title,
          subtitle: run.displayTitle,
          repoPath,
          repoName: repoNameFromPath(repoPath),
          target: { type: "run", runId: run.id },
          dedupeKey: `run:${run.id}:${run.conclusion}`,
        },
        os: { title, body: run.displayTitle, focus: "unfocused" },
      });
    }
  });

  // Keyed on the result time too: structural sharing keeps an unchanged list's
  // reference, and the prime must still advance on every poll.
  useEffect(() => {
    if (poll.data) diff(poll.data, poll.dataUpdatedAt);
  }, [poll.data, poll.dataUpdatedAt]);
}
