import { useQuery } from "@tanstack/react-query";
import { loadAutomations, repoAutomationsFor } from "@/lib/automations/store";
import { maybeCatchUpMissedOpen, maybeFireSync } from "@/lib/automations/sync";
import { effectiveActions } from "@/lib/automations/types";
import { forgePrPoll, forgeStatus } from "@/lib/git/api";
import { forgeFeatureReady } from "@/lib/git/queries";
import { repoIdentity } from "@/lib/git/repo-identity";
import { loadSettings } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { COLD_START_AUTOMATIONS_OFF } from "@/lib/test-mode";

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
 * with no automations makes no background calls here. React Query runs the first
 * tick immediately on mount (app startup), so the initial settings/automations
 * read happens once at launch; it stays cheap because every forge call is gated
 * behind an explicit rule and an empty-recents early-exit.
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
      // Hiding AI features pauses automations, so a paused tick makes no forge call.
      // Settings are read per tick, so flipping it takes effect on the next one.
      if (settings.hideAi) return { polled: 0 };
      // A cold-start instance runs no automations unless opted in, so this poller
      // makes no forge calls.
      if (COLD_START_AUTOMATIONS_OFF) return { polled: 0 };
      // No recents → nothing to watch; skip the config read and the loop.
      if (settings.recentRepos.length === 0) return { polled: 0 };
      const config = await loadAutomations();
      // Read the active repo imperatively at poll time (not reactively) so the
      // exclusion reflects wherever the user is right now. Resolve its
      // worktree-stable identity once (memoized) so a WORKTREE of the active repo
      // — a different checkout path but the SAME identity — is excluded too: a raw
      // path compare would miss it and double-fire against usePrNotifications.
      const activeRepo = useUiStore.getState().repoPath;
      const activeIdentity = activeRepo ? await repoIdentity(activeRepo) : null;

      let polled = 0;
      for (const repo of settings.recentRepos) {
        const path = repo.path;
        // The active repo is covered by usePrNotifications (with notifications).
        if (path === activeRepo) continue;
        try {
          // Identity-resolved override lookup (with legacy-path fallback), then
          // the rule gate: only repos carrying a pr-sync OR a pr-open rule are
          // worth a forge poll (pr-open earns the poll for the missed-open
          // catch-up, exactly as it does in usePrNotifications).
          const entry = await repoAutomationsFor(config, path);
          const hasPrSync =
            effectiveActions(config, entry, "pr-sync").length > 0;
          const hasPrOpen =
            effectiveActions(config, entry, "pr-open").length > 0;
          if (!hasPrSync && !hasPrOpen) continue;
          // Skip a worktree/alias of the active repo: same identity, different
          // path (usePrNotifications already polls that identity). After the rule
          // gate so only rule-bearing repos pay it — and repoAutomationsFor above
          // already warmed this path's memoized identity, so it's a cache hit.
          if (activeIdentity && (await repoIdentity(path)) === activeIdentity)
            continue;

          // Forge-ready gate: skip repos whose hosted integration isn't wired up
          // for PRs (unauth'd, non-hosted, or a provider we haven't built yet).
          const status = await forgeStatus(path);
          if (!forgeFeatureReady(status, "pullRequests")) continue;

          const prs = await forgePrPoll(path);
          polled++;
          if (hasPrSync) {
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
          }
          // pr-open catch-up for PRs opened outside the app — the viewer login
          // comes from the forge status already fetched above.
          if (hasPrOpen) {
            const candidates = prs
              .filter((pr) => pr.state === "OPEN" && pr.headSha)
              .map((pr) => ({
                ref: String(pr.number),
                currentHeadSha: pr.headSha,
                base: pr.baseRefName,
                head: pr.headRefName,
                title: pr.title,
                author: pr.author,
                createdAt: pr.createdAt,
                isDraft: pr.isDraft,
              }));
            maybeCatchUpMissedOpen(
              path,
              candidates,
              status.login ?? null,
              settings.reviewDraftPrs,
            );
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
