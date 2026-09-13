import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import {
  forgeFeatureReady,
  useForgeStatus,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  forgeCiRunList,
  isRunActive,
  type WorkflowRun,
} from "@/lib/github/actions";
import { emitNotification } from "@/lib/notifications/emit";
import { anyChannelOn } from "@/lib/notifications/overrides";
import { useRepoNotificationOverride } from "@/lib/notifications/queries";
import { useSettings } from "@/lib/settings/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { isFailureConclusion, statusLabel } from "./status";

/**
 * Background poller for OS notifications on the current branch's workflow runs:
 * roughly every 45s (also while unfocused) it snapshots recent runs and
 * notifies when one transitions from active to completed. The first poll after
 * opening a repo (or switching branch) only primes the snapshot.
 */
export function useRunNotifications(repoPath: string) {
  const settings = useSettings();
  const gh = useForgeStatus(repoPath);
  const status = useRepoStatus(repoPath);
  const branch = status.data?.branch.name ?? null;
  const override = useRepoNotificationOverride(repoPath);
  // Polled for any provider whose CI read is built — GitHub Actions and GitLab
  // pipelines both map onto the same neutral run shape the diff below reads.
  // Shares the emit gate's resolution once the override is in hand: it reads undefined
  // until the overrides query resolves, so a muted repo can still fire its first poll.
  // Delivery stays correct regardless — emit re-reads the override itself.
  const enabled =
    repoPath !== "" &&
    forgeFeatureReady(gh.data, "ci") &&
    Boolean(branch) &&
    settings.data !== undefined &&
    anyChannelOn(settings.data.notifications, override, ["actionRuns"]);

  const poll = useQuery({
    queryKey: ["repo", repoPath, "actions", "notify", branch ?? ""] as const,
    queryFn: () => forgeCiRunList(repoPath, 20, branch ?? undefined),
    enabled,
    refetchInterval: 45_000,
    refetchIntervalInBackground: true,
    staleTime: 40_000,
    retry: false,
  });

  // Reset the snapshot when the repo or branch changes, so we don't fire a
  // backlog of "finished" notifications after a context switch. The check lives
  // inside the effect event (reading the latest key off the render path) so it
  // primes fresh on the first diff after a switch.
  const prev = useRef<Map<number, WorkflowRun> | null>(null);
  const prevKey = useRef(`${repoPath}:${branch}`);

  const diff = useEffectEvent((runs: WorkflowRun[]) => {
    const key = `${repoPath}:${branch}`;
    if (prevKey.current !== key) {
      prevKey.current = key;
      prev.current = null;
    }
    const snapshot = new Map(runs.map((r) => [r.id, r]));
    const before = prev.current;
    prev.current = snapshot;
    if (!before) return;

    for (const run of snapshot.values()) {
      const old = before.get(run.id);
      // Notify only on the active → completed edge we actually witnessed.
      if (old && isRunActive(old.status) && run.status === "completed") {
        const ok = run.conclusion === "success";
        const bad = isFailureConclusion(run.conclusion);
        if (!ok && !bad) continue; // skipped/cancelled/neutral: stay quiet
        const title = `${run.workflowName} ${statusLabel(run.status, run.conclusion).toLowerCase()} on ${run.headBranch}`;
        emitNotification({
          source: "actionRuns",
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
    }
  });

  useEffect(() => {
    if (poll.data) diff(poll.data);
  }, [poll.data]);
}
