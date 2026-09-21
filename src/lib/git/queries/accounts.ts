import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { COLD_START_NO_GH } from "@/lib/test-mode";
import * as api from "../api";
import type {
  ForgeCapabilities,
  ForgeImplemented,
  ForgeStatus,
} from "../types";
import { MY_WORK_PAGES_KEY, MY_WORK_SOURCES_KEY } from "./forge-repos";

export function useGhAccounts() {
  return useQuery({
    queryKey: ["gh-accounts"] as const,
    queryFn: api.ghAccounts,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSwitchAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { host: string; login: string }) =>
      api.ghSwitchAccount(args.host, args.login),
    // Deliberately app-wide (no key filter): the active account changes every
    // gh-derived answer, and switches are rare enough that the collateral refetch
    // beats the narrow-invalidation policy used elsewhere.
    onSettled: () => queryClient.invalidateQueries(),
  });
}

/** The saved Bitbucket account (Atlassian API token), or null when none. A fast
 *  keyring check — no network. Connecting/disconnecting invalidates this key and
 *  the forge-status queries so open Bitbucket repos flip ready without a restart. */
export function useBbAccount() {
  return useQuery({
    queryKey: ["bb-account"] as const,
    queryFn: api.forgeBbAccount,
    staleTime: 60_000,
    retry: false,
  });
}

/** The forge session health for THIS repo's provider — drives the "session
 *  expired" reconnect affordances on the not-ready ladders and the expiry notice.
 *  A `state` of "offline" (inconclusive probe) is treated as "no change" by every
 *  consumer, so a network blip never flips the UI. Repo-keyed (repo at index 1). */
export function useForgeSessionHealth(repoPath: string) {
  return useQuery({
    queryKey: ["repo", repoPath, "forge-session-health"] as const,
    queryFn: () => api.forgeSessionHealth(repoPath),
    staleTime: 5 * 60_000,
    enabled: !!repoPath,
    retry: false,
  });
}

/** The health of every known forge account (gh accounts + glab hosts) — the
 *  Accounts settings section merges this into its rows to badge expired sessions
 *  and warn before a knowable token expiry. */
export function useAccountsHealth() {
  return useQuery({
    queryKey: ["accounts-health"] as const,
    queryFn: api.forgeAccountsHealth,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Refresh everything a successful reconnect can change: the accounts-health list,
 *  every repo's forge-status (a dead session flips a repo back to ready) and
 *  forge-session-health, the gh-accounts list (which account is active), the gh
 *  token scopes (a reconnect can grant new ones), and the repo-settings lists a
 *  scope hint sends users here from — secrets, variables and webhooks all fail
 *  closed on a missing scope, so their error cards must retry the call themselves,
 *  as do the six GitHub Projects reads (catalog, memberships, field values, a
 *  board's field definitions, its saved views, and its items): a granted `project`
 *  scope has to light the picker, the rail's field lines, the field editor and the
 *  Projects board up without a restart, and the work inbox's sources probe plus
 *  its pages (a `login` mode reconnect is how a forge becomes a source in the
 *  first place).
 *  Call from a reconnect's `finished: ok` handler. */
export function useInvalidateAfterReconnect() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["accounts-health"] });
    queryClient.invalidateQueries({ queryKey: ["gh-accounts"] });
    // Partial key: covers every host variant of useGhScopes' key.
    queryClient.invalidateQueries({ queryKey: ["gh", "token-scopes"] });
    queryClient.invalidateQueries({
      // Partial keys with a repo path in slot 1, so match on the axis instead.
      // Its charter is SCOPE-GRANT RECOVERY only: every axis listed here is one a
      // newly granted scope can change the answer to. Cache identity across
      // ACCOUNTS is a query-key-axis concern — a cache that may hold another
      // account's answer needs that account in its key, never a wider sweep here.
      predicate: (q) =>
        q.queryKey[0] === "repo" &&
        (q.queryKey[2] === "forge-status" ||
          q.queryKey[2] === "forge-session-health" ||
          q.queryKey[2] === "secrets" ||
          q.queryKey[2] === "variables" ||
          q.queryKey[2] === "webhooks" ||
          q.queryKey[2] === "projects-available" ||
          q.queryKey[2] === "item-projects" ||
          q.queryKey[2] === "item-field-values" ||
          q.queryKey[2] === "project-fields" ||
          q.queryKey[2] === "project-views" ||
          // Slot 2, so every LENS of a board is covered: the items key carries
          // the saved view's filter after the board id.
          q.queryKey[2] === "project-items"),
    });
    // A `login` here is a real source change for the work inbox — its probe gates
    // each forge's leg on a 5-minute window, so without this a session signed in
    // from the dialog reads as "not connected" until the window lapses. The pages
    // follow: what a leg returns depends on the session that fetched it.
    queryClient.invalidateQueries({ queryKey: MY_WORK_SOURCES_KEY });
    queryClient.invalidateQueries({ queryKey: MY_WORK_PAGES_KEY });
  }, [queryClient]);
}

const gitlabReviewBotKey = ["settings", "gitlab-review-bot"] as const;

/** The configured GitLab review-bot login, or null when none. A fast keyring
 *  check — no network. The stored value is only ever the returned login; the
 *  token itself never lands in query data. */
export function useGitlabReviewBotStatus() {
  return useQuery({
    queryKey: gitlabReviewBotKey,
    queryFn: api.forgeGitlabReviewTokenStatus,
    staleTime: 60_000,
    retry: false,
  });
}

/** Save a GitLab review-bot token (validated backend-side); returns the bot login,
 *  which is what the status query then reflects. */
export function useSetGitlabReviewToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.forgeGitlabReviewTokenSet(token),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: gitlabReviewBotKey }),
  });
}

/** Clear the configured GitLab review-bot token. */
export function useClearGitlabReviewToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.forgeGitlabReviewTokenClear(),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: gitlabReviewBotKey }),
  });
}

/** The "no hosted integration" status cold-start test mode forces. */
const NO_FORGE_STATUS: ForgeStatus = {
  provider: null,
  installed: false,
  authenticated: false,
  login: null,
  repo: null,
  host: null,
  capabilities: {
    pullRequests: false,
    draftPrs: false,
    issues: false,
    labels: false,
    milestones: false,
    reactions: false,
    discussions: false,
    stars: false,
    ci: false,
    webhooks: false,
    approvals: false,
    securityFindings: false,
  },
  implemented: {
    pullRequests: false,
    issues: false,
    ci: false,
    releases: false,
    insights: false,
    repoActions: false,
    repoSearch: false,
    repoForkByName: false,
    repoStar: false,
    repoReadme: false,
    publish: false,
    issueComment: false,
    issueState: false,
    mrComment: false,
    mrState: false,
    mrApprove: false,
    mrMerge: false,
    mrAutoMerge: false,
    issueLabels: false,
    mrLabels: false,
    issueAssignees: false,
    issueCreate: false,
    mrCreate: false,
    ciRerun: false,
    ciCancel: false,
    ciDispatch: false,
    releaseCreate: false,
    releaseEdit: false,
    mrAssignees: false,
    mrRequestChanges: false,
    mrReviewers: false,
    issueEdit: false,
    mrEdit: false,
    mrCommentEdit: false,
    issueCommentEdit: false,
    issueMilestone: false,
    issueReactions: false,
    mrReactions: false,
    issueLock: false,
    issueTransfer: false,
    issueDelete: false,
    issueConfidential: false,
    issueDueDate: false,
    repoSettings: false,
    ciJobPlay: false,
    ciJobRerun: false,
    timeTracking: false,
    issueLinks: false,
    prTasks: false,
    mrReviewThreads: false,
    mrThreadReply: false,
    mrThreadResolve: false,
    mrThreadCommentEdit: false,
    commitComments: false,
    mrThreadCreate: false,
    mrReviewSubmit: false,
    mrDraftToggle: false,
    forkActivity: false,
    forkCompare: false,
    listFilterMine: false,
    listFilterTeam: false,
    listFilterAuthor: false,
    reviewGrouping: false,
  },
};

/**
 * Provider-neutral hosted-integration status — the gate every hosted panel reads
 * (GitHub, GitLab and Bitbucket all dispatch behind it). Honors the cold-start test
 * mode; the probe hits the real CLIs otherwise.
 */
export function useForgeStatus(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "forge-status"] as const,
    queryFn: COLD_START_NO_GH
      ? (): Promise<ForgeStatus> => Promise.resolve(NO_FORGE_STATUS)
      : () => api.forgeStatus(repo),
    staleTime: 60_000,
    retry: false,
  });
}

/** Whether a repo's hosted integration is ready: tooling installed, signed in, and
 *  pointing at a recognized hosted repo. The provider-neutral gate hosted panels check
 *  before fetching or offering hosted actions. */
export function forgeReady(status: ForgeStatus | undefined | null): boolean {
  return Boolean(status?.installed && status?.authenticated && status?.repo);
}

/** Whether the repo's provider supports a given hosted capability — the gate for
 *  a control that some platforms lack (GitLab has no Discussions; Bitbucket has no
 *  labels/milestones/stars/reactions). GitHub is all-true, so this is a no-op gate
 *  there; it's the seam GitLab/Bitbucket need to hide what they can't do. */
export function forgeSupports(
  status: ForgeStatus | undefined | null,
  capability: keyof ForgeCapabilities,
): boolean {
  return Boolean(status?.capabilities[capability]);
}

/** Whether a hosted *feature* is usable here: the integration is ready AND GitDesktop
 *  has built that feature for this provider. Exactly `forgeReady` on GitHub; false on a
 *  *ready* GitLab/Bitbucket repo whose panel isn't wired yet, so it shows "coming
 *  soon". */
export function forgeFeatureReady(
  status: ForgeStatus | undefined | null,
  feature: keyof ForgeImplemented,
): boolean {
  return forgeReady(status) && Boolean(status?.implemented[feature]);
}
