import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { useAutomations } from "@/lib/automations/queries";
import { maybeCatchUpMissedOpen, maybeFireSync } from "@/lib/automations/sync";
import { effectiveActions, repoEntry } from "@/lib/automations/types";
import { forgePrPoll } from "@/lib/git/api";
import {
  forgeFeatureReady,
  useForgeStatus,
  useRepoIdentity,
} from "@/lib/git/queries";
import type { PrPollInfo } from "@/lib/git/types";
import { notifyIfUnfocused } from "@/lib/notify";
import { useSettings } from "@/lib/settings/queries";
import {
  type NotificationTone,
  pushNotification,
  repoNameFromPath,
} from "@/lib/stores/notifications";

/**
 * Background PR poller for OS notifications: roughly once a minute (also
 * while the window is unfocused — that's the point), it snapshots the
 * repo's recently-updated PRs and notifies on transitions the user opted
 * into — check rollups finishing, PRs opened/merged/closed, and review
 * decisions on their own PRs. The first poll after opening a repo only
 * primes the snapshot.
 */
export function usePrNotifications(repoPath: string) {
  const settings = useSettings();
  const gh = useForgeStatus(repoPath);
  const automations = useAutomations();
  const prefs = settings.data?.notifications;
  const anyNotif = Boolean(
    prefs && (prefs.prChecks !== "off" || prefs.prActivity || prefs.prReviews),
  );
  // A pr-sync rule needs this head-OID poll to spot new commits on remote PRs;
  // otherwise the poll only earns its keep when a PR notification is enabled, so
  // the default (no notifications, no pr-sync rule) makes no background call.
  // Resolve the repo's identity so a worktree checkout sees the same rules as main
  // (falls back to the raw path while identity is still resolving / for legacy keys).
  const repoId = useRepoIdentity(repoPath).data;
  const hasPrSync = automations.data
    ? effectiveActions(
        automations.data,
        repoEntry(automations.data, repoId ?? repoPath, repoPath),
        "pr-sync",
      ).length > 0
    : false;
  // A pr-open rule also needs this poll — it's how we catch up PRs opened OUTSIDE
  // the app (gh/web/bots), whose in-app pr-open event never fired. Without this,
  // a user with ONLY a pr-open rule (no notifications, no pr-sync) would never
  // poll and the catch-up would be dead.
  const hasPrOpen = automations.data
    ? effectiveActions(
        automations.data,
        repoEntry(automations.data, repoId ?? repoPath, repoPath),
        "pr-open",
      ).length > 0
    : false;
  // The head-OID poll (and pr-sync) run through the provider-neutral `forge_pr_poll`,
  // so the poller works for any ready hosted repo (GitHub/GitLab/Bitbucket). For
  // GitLab/Bitbucket the check-rollup and review-decision fields come back empty, so
  // those notification branches simply never fire there (a documented v1 limit) —
  // opened/merged/closed activity and remote pr-sync work on all three.
  const enabled =
    repoPath !== "" &&
    forgeFeatureReady(gh.data, "pullRequests") &&
    (anyNotif || hasPrSync || hasPrOpen);

  const poll = useQuery({
    queryKey: ["repo", repoPath, "pr-poll"] as const,
    queryFn: () => forgePrPoll(repoPath),
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    staleTime: 55_000,
    retry: false,
  });

  const prev = useRef<Map<number, PrPollInfo> | null>(null);
  const prevRepo = useRef(repoPath);

  // Effect event: reads the latest prefs/login without re-running the diff
  // when they change. The repo-change reset lives here too (reading the latest
  // repoPath off the render path) so a context switch primes fresh instead of
  // firing a backlog of transition notifications.
  const diff = useEffectEvent((data: PrPollInfo[]) => {
    if (prevRepo.current !== repoPath) {
      prevRepo.current = repoPath;
      prev.current = null;
    }
    const snapshot = new Map(data.map((p) => [p.number, p]));
    const before = prev.current;
    prev.current = snapshot;

    // pr-sync: auto re-review open remote PRs whose head advanced — the path
    // that covers PRs whose head branch isn't local (forks / pushed elsewhere).
    // Only when a pr-sync rule exists (so no fan-out for notification-only
    // users); deduped by head in `maybeFireSync`, and the runner gates whether
    // to actually review (opt-in per PR + per-mode watermark). Body/commit
    // subjects aren't in the poll payload — the PR diff is the source of truth.
    if (hasPrSync) {
      for (const pr of snapshot.values()) {
        if (pr.state === "OPEN" && pr.headSha) {
          maybeFireSync({
            repoPath,
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

    // pr-open catch-up: give your own PRs opened outside the app (gh/web/bots)
    // their missed initial review. Built from the same open+headSha snapshot,
    // carrying author/createdAt/isDraft; the function itself does the recency /
    // ownership / draft / already-reviewed gating and fires at most one per tick.
    if (hasPrOpen) {
      const candidates = [...snapshot.values()]
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
        repoPath,
        candidates,
        gh.data?.login ?? null,
        settings.data?.reviewDraftPrs ?? false,
      );
    }

    if (!before || !prefs) return;
    const login = gh.data?.login ?? null;
    const repoName = repoNameFromPath(repoPath);
    // The GitHub host of THIS repo, captured now so an author avatar in the global
    // inbox resolves against the row's own repo host, not the active repo's. Mirrors
    // `useForgeGhHost`: the host on GitHub, `null` off it (GitLab/Bitbucket logins
    // aren't avatar-derivable). Stored per-notification via `authorGhHost`.
    const ghHost =
      gh.data?.provider === "github" ? gh.data.host || "github.com" : null;
    // Record an event in BOTH channels: the persistent inbox (always — so a
    // focused user still gets a durable record, since notifyIfUnfocused no-ops
    // while focused) and an OS notification (unfocused only). The same pref
    // gates both, so turning a category off keeps it out of the inbox too.
    const record = (
      kind: string,
      tone: NotificationTone,
      title: string,
      pr: PrPollInfo,
      dedupeKey: string,
      // Only the events that know an author pass one (pr-opened). The poll payload
      // carries no avatar URL, so the row resolves the avatar from the login against
      // this repo's captured `ghHost` (login-derived photo on GitHub; bot handles via
      // the bot-avatar API; initials off GitHub / on failure).
      authorLogin?: string,
    ) => {
      pushNotification({
        kind,
        tone,
        title,
        subtitle: pr.title,
        repoPath,
        repoName,
        authorLogin,
        authorGhHost: authorLogin ? (ghHost ?? undefined) : undefined,
        target: { type: "pr", kind: "remote", ref: String(pr.number) },
        dedupeKey,
      });
      void notifyIfUnfocused(title, pr.title);
    };

    for (const pr of snapshot.values()) {
      const old = before.get(pr.number);
      const mine = login !== null && pr.author === login;

      if (
        prefs.prChecks !== "off" &&
        (prefs.prChecks === "all" || mine) &&
        old &&
        pr.state === "OPEN" &&
        old.checksState !== pr.checksState &&
        (pr.checksState === "SUCCESS" || pr.checksState === "FAILURE")
      ) {
        const passed = pr.checksState === "SUCCESS";
        record(
          passed ? "checks-passed" : "checks-failed",
          passed ? "success" : "danger",
          passed
            ? `Checks passed on #${pr.number}`
            : `Checks failed on #${pr.number}`,
          pr,
          `checks:${pr.number}:${pr.checksState}`,
        );
      }

      if (prefs.prActivity) {
        if (!old && pr.state === "OPEN" && !mine && !pr.isDraft) {
          record(
            "pr-opened",
            "info",
            `New pull request #${pr.number}`,
            pr,
            `opened:${pr.number}`,
            pr.author,
          );
        }
        if (old && old.state === "OPEN" && pr.state !== "OPEN") {
          const merged = pr.state === "MERGED";
          record(
            merged ? "pr-merged" : "pr-closed",
            merged ? "merged" : "neutral",
            `#${pr.number} was ${merged ? "merged" : "closed"}`,
            pr,
            `state:${pr.number}:${pr.state}`,
          );
        }
      }

      if (prefs.prReviews && mine && old) {
        // Approve / changes-requested is a review DECISION change.
        if (
          old.reviewDecision !== pr.reviewDecision &&
          (pr.reviewDecision === "APPROVED" ||
            pr.reviewDecision === "CHANGES_REQUESTED")
        ) {
          const approved = pr.reviewDecision === "APPROVED";
          record(
            approved ? "pr-approved" : "pr-changes-requested",
            approved ? "success" : "warning",
            approved
              ? `#${pr.number} was approved`
              : `Changes requested on #${pr.number}`,
            pr,
            `decision:${pr.number}:${pr.reviewDecision}`,
          );
        } else if (
          // A plain "commented" review: the review count rose but the decision
          // didn't change (an approve/changes-requested is caught just above).
          // Skip your OWN review (same `last:1` caveat noted on comments below).
          pr.reviewCount > old.reviewCount &&
          pr.lastReviewAuthor !== login
        ) {
          record(
            "pr-review",
            "info",
            `New review on #${pr.number}`,
            pr,
            `review:${pr.number}:${pr.reviewCount}`,
          );
        }
        // A new conversation comment on your PR — a SEPARATE event from the
        // review decision above, so this is an independent `if`, NOT chained onto
        // it: a reviewer who both decides AND leaves a standalone comment (or two
        // people acting in the same poll) should yield both notifications, never
        // a dropped one. Self-suppressed via `lastCommentAuthor` — which is the
        // author of the LATEST comment only (a `last:1` poll slice), so if someone
        // else and you both comment in the same ~60s window and yours lands last,
        // theirs is missed. An accepted rarity, not worth a full per-comment scan.
        if (
          pr.commentCount > old.commentCount &&
          pr.lastCommentAuthor !== login
        ) {
          record(
            "pr-comment",
            "info",
            `New comment on #${pr.number}`,
            pr,
            `comment:${pr.number}:${pr.commentCount}`,
          );
        }
      }

      // Review requested FROM you, on a PR you don't own.
      if (
        prefs.prReviews &&
        login !== null &&
        old &&
        pr.reviewRequests.includes(login) &&
        !old.reviewRequests.includes(login)
      ) {
        record(
          "review-requested",
          "info",
          `Review requested on #${pr.number}`,
          pr,
          // Per-viewer event — scope the dedupe to your login so a remove +
          // re-add of a DIFFERENT reviewer can't collide, and the key reads
          // honestly (the fire condition above is login-specific).
          `review-req:${pr.number}:${login}`,
        );
      }
    }
  });

  useEffect(() => {
    if (poll.data) diff(poll.data);
  }, [poll.data]);
}
