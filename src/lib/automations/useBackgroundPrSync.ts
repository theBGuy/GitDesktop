import { useQuery } from "@tanstack/react-query";
import { loadAutomations, repoAutomationsFor } from "@/lib/automations/store";
import { maybeFireSync } from "@/lib/automations/sync";
import { effectiveActions } from "@/lib/automations/types";
import { forgePrPoll, forgeStatus } from "@/lib/git/api";
import { forgeFeatureReady } from "@/lib/git/queries";
import { loadSettings } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";

/**
 * Always-mounted background poller that keeps pr-sync automations (auto
 * re-review on push) firing for recent repositories that AREN'T the one
 * currently open.
 *
 * Why it exists: the head-OID poll that detects a remote PR's new commits used
 * to live only in `usePrNotifications`, mounted in RepositoryView for the active
 * repo — so switching repos stopped polling the repo you left, and a push there
 * went undetected until you switched back (a re-review could land 20 minutes
 * late). Everything downstream is already repo-agnostic: the runner resolves
 * rules / diffs / comments / claims per `event.repoPath`, and `maybeFireSync`'s
 * module-level dedup map deliberately survives unmounts. Only the TRIGGER was
 * active-repo-gated, so this hook covers the gap.
 *
 * Cost bound: one forge poll per rule-bearing recent repo per minute — the loop
 * only polls repos that carry an explicit pr-sync rule (an opt-in), so a user
 * with no automations makes no background calls here.
 *
 * Active-repo exclusion: the repo open in the app is SKIPPED, because
 * RepositoryView's `usePrNotifications` poller already covers it (with the OS
 * notifications this hook deliberately omits).
 *
 * Double-fire safety: even on an overlap tick (a repo switch mid-poll, where a
 * repo is briefly seen by both pollers), `maybeFireSync`'s shared module-level
 * map dedupes by head, and the runner's cross-instance claim dedupes beyond
 * that — so a PR is never re-reviewed twice for the same head.
 */
export function useBackgroundPrSync(): void {
  useQuery({
    queryKey: ["background-pr-sync"] as const,
    // Polling while the window is unfocused is the point — a push to a repo you
    // aren't looking at is exactly what this catches.
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    staleTime: 55_000,
    retry: false,
    queryFn: async () => {
      const settings = await loadSettings();
      const config = await loadAutomations();
      // Read the active repo imperatively at poll time (not reactively) so the
      // exclusion reflects wherever the user is right now.
      const activeRepo = useUiStore.getState().repoPath;

      let polled = 0;
      for (const repo of settings.recentRepos) {
        const path = repo.path;
        // The active repo is covered by usePrNotifications (with notifications).
        if (path === activeRepo) continue;
        try {
          // Identity-resolved override lookup (with legacy-path fallback), then
          // the pr-sync gate: only rule-bearing repos are worth a forge poll.
          const entry = await repoAutomationsFor(config, path);
          if (effectiveActions(config, entry, "pr-sync").length === 0) continue;

          // Forge-ready gate: skip repos whose hosted integration isn't wired up
          // for PRs (unauth'd, non-hosted, or a provider we haven't built yet).
          const status = await forgeStatus(path);
          if (!forgeFeatureReady(status, "pullRequests")) continue;

          const prs = await forgePrPoll(path);
          polled++;
          for (const pr of prs) {
            if (pr.state === "OPEN" && pr.headSha) {
              maybeFireSync({
                repoPath: path,
                kind: "remote",
                ref: String(pr.number),
                currentHeadSha: pr.headSha,
                base: pr.baseRefName,
                head: pr.headRefName,
                title: pr.title,
                body: "",
                commitSubjects: [],
              });
            }
          }
        } catch {
          // One bad repo (deleted/moved path, transient forge error) must not
          // sink the batch — skip it and keep polling the rest.
        }
      }

      // A queryFn must not return undefined; a small summary is enough.
      return { polled };
    },
  });
}
