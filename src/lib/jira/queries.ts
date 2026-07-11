import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ForgeUserRef } from "@/lib/git/types";
import {
  jiraAccount,
  jiraIssueAssign,
  jiraIssueComment,
  jiraIssueCreate,
  jiraIssueList,
  jiraIssueTransition,
  jiraIssueTransitions,
  jiraIssueTransitionTo,
  jiraIssueTypes,
  jiraIssueView,
  jiraPermissions,
  jiraProjectSearch,
  jiraUserSearch,
} from "./api";
import {
  clearJiraLink,
  getJiraLink,
  type JiraLink,
  setJiraLink,
} from "./store";
import type {
  JiraIssueDetails,
  JiraIssueInfo,
  JiraIssueState,
  JiraStatusCategory,
  JiraTransitionDirection,
} from "./types";

const jiraLinkKey = (repo: string) => ["jira-link", repo] as const;

/** This repo's Jira link (or `null` when unlinked). */
export function useJiraLink(repo: string) {
  return useQuery({
    queryKey: jiraLinkKey(repo),
    queryFn: () => getJiraLink(repo),
  });
}

/** Invalidate the link query AND every Jira issue-list/issue-detail query for
 *  this repo. The issue queries key on the link's site + project, so re-linking
 *  to a different project mints new keys — but the OLD keys' caches would linger
 *  (up to staleTime) and could be served on a same-identity re-link; a predicate
 *  sweep of both issue namespaces drops them so the panel/detail refetch. */
function invalidateJiraForRepo(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
) {
  queryClient.invalidateQueries({ queryKey: jiraLinkKey(repo) });
  queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "repo" &&
      q.queryKey[1] === repo &&
      (q.queryKey[2] === "jira-issues" || q.queryKey[2] === "jira-issue"),
  });
}

export function useSaveJiraLink(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (link: JiraLink) => setJiraLink(repo, link),
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

export function useClearJiraLink(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearJiraLink(repo),
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** The stored account for a site (fast keyring check, no network); `null` when
 *  none. Disabled until a site host is present. */
export function useJiraAccount(site: string) {
  return useQuery({
    queryKey: ["jira-account", site] as const,
    queryFn: () => jiraAccount(site),
    enabled: site.length > 0,
  });
}

/** The linked project's issues for a state filter. Enabled only when the repo is
 *  linked; the query surfaces a revoked/expired token as an error the panel
 *  renders with a "Reconnect" affordance. */
export function useJiraIssues(
  repo: string,
  link: JiraLink | null | undefined,
  state: JiraIssueState,
) {
  return useQuery({
    // The link's site + project are part of the key so a re-link to a different
    // project (or site) is a distinct cache entry — never served the prior
    // project's list. `?? ""` keeps the key stable while `link` is absent (the
    // query is disabled then anyway).
    queryKey: [
      "repo",
      repo,
      "jira-issues",
      link?.siteHost ?? "",
      link?.projectKey ?? "",
      state,
    ] as const,
    queryFn: () =>
      jiraIssueList(
        // Non-null: the query is disabled unless `link` is present.
        (link as JiraLink).siteHost,
        (link as JiraLink).projectKey,
        state,
      ),
    enabled: !!link,
    staleTime: 30_000,
  });
}

/** One Jira issue's full detail. Enabled only when linked and a key is selected. */
export function useJiraIssue(
  repo: string,
  link: JiraLink | null | undefined,
  key: string | null,
) {
  return useQuery({
    // Site is part of the key so a re-link to a different site can't serve the
    // prior site's detail for the same key.
    queryKey: ["repo", repo, "jira-issue", link?.siteHost ?? "", key] as const,
    queryFn: () => jiraIssueView((link as JiraLink).siteHost, key as string),
    enabled: !!link && key !== null,
    placeholderData: keepPreviousData,
  });
}

/** Project search for the link picker. Debounced-input driven by the caller;
 *  enabled only once a site is present (the caller passes `""` until validated
 *  to keep it off). */
export function useJiraProjectSearch(site: string, query: string) {
  return useQuery({
    queryKey: ["jira-project-search", site, query] as const,
    queryFn: () => jiraProjectSearch(site, query),
    enabled: site.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

// ── Write path (phase 2) ────────────────────────────────────────────────────

/** The detail-cache key for one issue — must match `useJiraIssue`'s key exactly
 *  so optimistic patches and reads land on the same entry. */
const jiraIssueDetailKey = (repo: string, site: string, key: string) =>
  ["repo", repo, "jira-issue", site, key] as const;

/** The linked project's write permissions (server-resolved). Enabled only when
 *  linked; permissions change rarely, so a generous staleTime keeps this off the
 *  hot path. A failed probe surfaces as `isError` with `data === undefined`; the
 *  gate callers read `data?.<flag> ?? false`, so a failure treats every write as
 *  not-permitted (affordances absent) without touching the read path. */
export function useJiraPermissions(
  repo: string,
  link: JiraLink | null | undefined,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "jira-permissions",
      link?.siteHost ?? "",
      link?.projectKey ?? "",
    ] as const,
    queryFn: () =>
      jiraPermissions(
        (link as JiraLink).siteHost,
        (link as JiraLink).projectKey,
      ),
    enabled: !!link,
    staleTime: 5 * 60_000,
    // A permission probe failing must not spam retries — one failure = treat
    // writes as absent until the next natural refetch.
    retry: 1,
  });
}

/** The project's creatable issue types. Enabled only when linked and the caller
 *  opts in (e.g. the create dialog is open). Surfaces its error so the dialog can
 *  offer a retry rather than a dead Select. */
export function useJiraIssueTypes(
  repo: string,
  link: JiraLink | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "jira-issue-types",
      link?.siteHost ?? "",
      link?.projectKey ?? "",
    ] as const,
    queryFn: () =>
      jiraIssueTypes(
        (link as JiraLink).siteHost,
        (link as JiraLink).projectKey,
      ),
    enabled: !!link && enabled,
    staleTime: 5 * 60_000,
  });
}

/** Assignable-user search for the assignee picker. Debounced input driven by the
 *  caller (mirrors the project-search idiom); enabled only when linked and the
 *  picker is open. `key` scopes the search to the issue's project + permissions. */
export function useJiraUserSearch(
  link: JiraLink | null | undefined,
  issueKey: string,
  query: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "jira-user-search",
      link?.siteHost ?? "",
      issueKey,
      query,
    ] as const,
    queryFn: () => jiraUserSearch((link as JiraLink).siteHost, issueKey, query),
    enabled: !!link && enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Add a comment. Optimistic: appends the returned comment to the detail cache
 *  on success (the server assigns the id + timestamp, so — unlike the transition
 *  patch — there's nothing to show until it resolves). Invalidates the repo's
 *  Jira caches on settle to reconcile. */
export function useJiraComment(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; bodyMd: string }) =>
      jiraIssueComment((link as JiraLink).siteHost, args.issueKey, args.bodyMd),
    onSuccess: (comment, args) => {
      if (!link) return;
      const key = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);
      queryClient.setQueryData<JiraIssueDetails>(key, (d) =>
        d ? { ...d, comments: [...d.comments, comment] } : d,
      );
    },
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** The available workflow transitions from an issue's current status, for the
 *  full status picker. Fetched lazily — the caller passes `enabled` (e.g. the
 *  status menu being open) so nothing is fetched on mount. Site is part of the
 *  key so a re-link can't serve the prior site's transitions for the same key. */
export function useJiraTransitions(
  repo: string,
  link: JiraLink | null | undefined,
  key: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "jira-transitions",
      link?.siteHost ?? "",
      key,
    ] as const,
    queryFn: () => jiraIssueTransitions((link as JiraLink).siteHost, key),
    enabled: !!link && enabled,
    staleTime: 30_000,
  });
}

/** The shared optimistic context for a status change (detail snapshot + every
 *  patched list cache), so rollback can restore exactly what onMutate touched. */
type StatusPatchCtx = {
  detailKey: readonly unknown[] | null;
  prevDetail: JiraIssueDetails | undefined;
  lists: [readonly unknown[], JiraIssueInfo[] | undefined][];
};

/** Optimistically flip an issue's status category (and, when known, its name)
 *  across the detail cache AND every jira-issues list cache for this repo, so the
 *  chip + any visible row update instantly. Shared by both transition mutations.
 *  `name === undefined` (the directional path, which can't know the per-workflow
 *  target name yet) leaves the existing name; the real values land on success. */
async function applyOptimisticStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
  link: JiraLink,
  issueKey: string,
  category: JiraStatusCategory,
  name: string | undefined,
): Promise<StatusPatchCtx> {
  const detailKey = jiraIssueDetailKey(repo, link.siteHost, issueKey);
  await queryClient.cancelQueries({ queryKey: detailKey });
  const prevDetail = queryClient.getQueryData<JiraIssueDetails>(detailKey);
  if (prevDetail) {
    queryClient.setQueryData<JiraIssueDetails>(detailKey, {
      ...prevDetail,
      statusCategory: category,
      ...(name !== undefined ? { statusName: name } : {}),
    });
  }
  const lists = queryClient.getQueriesData<JiraIssueInfo[]>({
    predicate: (q) =>
      q.queryKey[0] === "repo" &&
      q.queryKey[1] === repo &&
      q.queryKey[2] === "jira-issues",
  });
  for (const [listKey, list] of lists) {
    if (!list) continue;
    queryClient.setQueryData<JiraIssueInfo[]>(
      listKey,
      list.map((i) =>
        i.key === issueKey
          ? {
              ...i,
              statusCategory: category,
              ...(name !== undefined ? { statusName: name } : {}),
            }
          : i,
      ),
    );
  }
  return { detailKey, prevDetail, lists };
}

/** Restore the detail + list caches from a StatusPatchCtx (rollback on error). */
function rollbackOptimisticStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  ctx: StatusPatchCtx | undefined,
) {
  if (ctx?.detailKey && ctx.prevDetail !== undefined) {
    queryClient.setQueryData(ctx.detailKey, ctx.prevDetail);
  }
  for (const [listKey, list] of ctx?.lists ?? []) {
    queryClient.setQueryData(listKey, list);
  }
}

/** Land the server's REAL status name + category onto the detail cache (success),
 *  so the chip reads e.g. "Done" not the generic optimistic guess. */
function landRealStatus(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
  link: JiraLink,
  issueKey: string,
  statusName: string,
  statusCategory: JiraStatusCategory,
) {
  const detailKey = jiraIssueDetailKey(repo, link.siteHost, issueKey);
  queryClient.setQueryData<JiraIssueDetails>(detailKey, (d) =>
    d ? { ...d, statusName, statusCategory } : d,
  );
}

/** Close/reopen via a directional workflow transition. Optimistic: flips the
 *  category across the detail cache AND every list cache for this repo (so the
 *  row's chip flips instantly). Rollback on error restores both. The list patch
 *  may make a row fall out of the active state filter (e.g. closing while viewing
 *  Open) — that's fine: the detail view stays put and invalidation reconciles the
 *  list on settle. */
export function useJiraTransition(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      direction: JiraTransitionDirection;
    }) =>
      jiraIssueTransition(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.direction,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      // We don't yet know the real target status name (it's per-workflow), so
      // only flip the category (name undefined) — enough to move the chip's
      // open/closed treatment; the returned real name lands on success.
      const category: JiraStatusCategory =
        args.direction === "close" ? "done" : "new";
      return applyOptimisticStatus(
        queryClient,
        repo,
        link,
        args.issueKey,
        category,
        undefined,
      );
    },
    onError: (_e, _args, ctx) => rollbackOptimisticStatus(queryClient, ctx),
    onSuccess: (result, args) => {
      if (!link) return;
      landRealStatus(
        queryClient,
        repo,
        link,
        args.issueKey,
        result.statusName,
        result.statusCategory,
      );
    },
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** Apply a specific transition by id (the full status picker). Same optimistic
 *  plumbing as `useJiraTransition`, but the caller knows the target from the
 *  chosen option, so we flip BOTH category and name up front; the server's real
 *  values still land on success and invalidation reconciles on settle. */
export function useJiraTransitionTo(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      transitionId: string;
      toStatusName: string;
      toStatusCategory: JiraStatusCategory;
    }) =>
      jiraIssueTransitionTo(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.transitionId,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      return applyOptimisticStatus(
        queryClient,
        repo,
        link,
        args.issueKey,
        args.toStatusCategory,
        args.toStatusName,
      );
    },
    onError: (_e, _args, ctx) => rollbackOptimisticStatus(queryClient, ctx),
    onSuccess: (result, args) => {
      if (!link) return;
      landRealStatus(
        queryClient,
        repo,
        link,
        args.issueKey,
        result.statusName,
        result.statusCategory,
      );
    },
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** Set/clear the single assignee. Optimistic: patches the assignee onto the
 *  detail cache (and the matching list row) with rollback. */
export function useJiraAssign(repo: string, link: JiraLink | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; assignee: ForgeUserRef | null }) =>
      jiraIssueAssign(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.assignee?.id ?? null,
      ),
    onMutate: async (args) => {
      if (!link) return { detailKey: null, prevDetail: undefined, lists: [] };
      const detailKey = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const prevDetail = queryClient.getQueryData<JiraIssueDetails>(detailKey);
      if (prevDetail) {
        queryClient.setQueryData<JiraIssueDetails>(detailKey, {
          ...prevDetail,
          assignee: args.assignee,
        });
      }
      const lists = queryClient.getQueriesData<JiraIssueInfo[]>({
        predicate: (q) =>
          q.queryKey[0] === "repo" &&
          q.queryKey[1] === repo &&
          q.queryKey[2] === "jira-issues",
      });
      for (const [listKey, list] of lists) {
        if (!list) continue;
        queryClient.setQueryData<JiraIssueInfo[]>(
          listKey,
          list.map((i) =>
            i.key === args.issueKey ? { ...i, assignee: args.assignee } : i,
          ),
        );
      }
      return { detailKey, prevDetail, lists };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.detailKey && ctx.prevDetail !== undefined) {
        queryClient.setQueryData(ctx.detailKey, ctx.prevDetail);
      }
      for (const [listKey, list] of ctx?.lists ?? []) {
        queryClient.setQueryData(listKey, list);
      }
    },
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** Create an issue. Invalidates the repo's Jira caches on settle so the new
 *  issue appears in the list; the caller handles selecting it + the toast. */
export function useJiraCreateIssue(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueTypeId: string;
      summary: string;
      descriptionMd?: string;
    }) =>
      jiraIssueCreate(
        (link as JiraLink).siteHost,
        (link as JiraLink).projectKey,
        args.issueTypeId,
        args.summary,
        args.descriptionMd,
      ),
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}
