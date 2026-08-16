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
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import {
  type NotificationKind,
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
  // Hiding AI features pauses automations, so the automation arms below go inert —
  // but the poll itself keeps running for the non-AI notifications it also drives.
  const aiEnabled = useAiEnabled();
  const prefs = settings.data?.notifications;
  const anyNotif = Boolean(
    prefs && (prefs.prChecks !== "off" || prefs.prActivity || prefs.prReviews),
  );
  // The poll only earns its keep when a notification, pr-sync, or pr-open rule wants
  // it — the default (none of those) makes no background call.
  // Rules are keyed by repo IDENTITY so a worktree checkout sees the same rules as
  // main; the raw path is the fallback while identity resolves / for legacy keys.
  const repoId = useRepoIdentity(repoPath).data;
  const hasPrSync = automations.data
    ? effectiveActions(
        automations.data,
        repoEntry(automations.data, repoId ?? repoPath, repoPath),
        "pr-sync",
      ).length > 0
    : false;
  // A pr-open rule also needs the poll: it's how PRs opened OUTSIDE the app
  // (gh/web/bots) get their missed initial review — with only a pr-open rule and no
  // notifications, nothing else would poll and the catch-up would be dead.
  const hasPrOpen = automations.data
    ? effectiveActions(
        automations.data,
        repoEntry(automations.data, repoId ?? repoPath, repoPath),
        "pr-open",
      ).length > 0
    : false;
  // `forge_pr_poll` is provider-neutral, so the poller works on any ready hosted repo.
  // GitLab/Bitbucket return empty check-rollup, review-decision, comment and
  // review-request fields, so those notification branches never fire there (a
  // documented v1 limit); opened/merged/closed activity and remote pr-sync work on
  // all three.
  const enabled =
    repoPath !== "" &&
    forgeFeatureReady(gh.data, "pullRequests") &&
    (anyNotif || ((hasPrSync || hasPrOpen) && aiEnabled));

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

    // pr-sync: auto re-review open remote PRs whose head advanced — covers PRs whose
    // head branch isn't local (forks / pushed elsewhere). Gated on hasPrSync so
    // notification-only users get no fan-out. The poll payload has no body/commit
    // subjects — the PR diff is the source of truth.
    if (hasPrSync && aiEnabled) {
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

    // pr-open catch-up for your own PRs opened outside the app (gh/web/bots), built
    // from the same open+headSha snapshot plus author/createdAt/isDraft.
    // `maybeCatchUpMissedOpen` owns the recency/ownership/draft/already-reviewed
    // gating and fires at most one per tick.
    if (hasPrOpen && aiEnabled) {
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
    // THIS repo's GitHub host, captured now so an author avatar in the global inbox
    // resolves against the row's own repo host, not the active repo's. Mirrors
    // `useForgeGhHost`: null off GitHub (GitLab/Bitbucket logins aren't avatar-derivable).
    const ghHost =
      gh.data?.provider === "github" ? gh.data.host || "github.com" : null;
    // Both channels: the persistent inbox always (notifyIfUnfocused no-ops while
    // focused, so a focused user still gets a durable record) and an OS notification
    // when unfocused. One pref gates both, so turning a category off also hides it
    // from the inbox.
    const record = (
      kind: NotificationKind,
      tone: NotificationTone,
      title: string,
      pr: PrPollInfo,
      dedupeKey: string,
      // Only events that know an author pass one (pr-opened). No avatar URL in the
      // poll payload — the row derives it from the login + `ghHost` (bot handles via
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
          // A plain "commented" review: count rose, decision unchanged. Skip your
          // OWN (same `last:1` caveat as comments below).
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
        // A SEPARATE event from the review decision above — an independent `if`, not
        // chained, so a reviewer who both decides and comments (or two people in one
        // poll) yields both notifications. Self-suppression reads `lastCommentAuthor`,
        // which is the author of the LATEST comment only (the poll's `comments(last:1)`
        // slice), so if someone else comments in the same ~60s window and yours lands
        // last, theirs is missed — an accepted rarity.
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

      // Review requested FROM you — no author guard needed; a forge won't request
      // review from the PR's own author.
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
          // Per-viewer event — scope the dedupe to your login so a remove + re-add
          // of a DIFFERENT reviewer can't collide.
          `review-req:${pr.number}:${login}`,
        );
      }
    }
  });

  useEffect(() => {
    if (poll.data) diff(poll.data);
  }, [poll.data]);
}
