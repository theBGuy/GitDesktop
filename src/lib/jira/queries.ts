import {
  keepPreviousData,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ForgeUserRef } from "@/lib/git/types";
import {
  jiraAccount,
  jiraCommentDelete,
  jiraCommentEdit,
  jiraIssueAssign,
  jiraIssueComment,
  jiraIssueCreate,
  jiraIssueList,
  jiraIssueSetDueDate,
  jiraIssueSetLabels,
  jiraIssueSetOriginalEstimate,
  jiraIssueSetPriority,
  jiraIssueSetRemainingEstimate,
  jiraIssueTransition,
  jiraIssueTransitions,
  jiraIssueTransitionTo,
  jiraIssueTypes,
  jiraIssueView,
  jiraLabels,
  jiraPermissions,
  jiraPriorities,
  jiraProjectSearch,
  jiraUserSearch,
  jiraWorklogAdd,
  jiraWorklogDelete,
  jiraWorklogUpdate,
} from "./api";
import {
  clearJiraLink,
  getJiraLink,
  type JiraLink,
  setJiraLink,
} from "./store";
import type {
  JiraComment,
  JiraIssueDetails,
  JiraIssueInfo,
  JiraIssueState,
  JiraStatusCategory,
  JiraTransitionDirection,
} from "./types";

const jiraLinkKey = (repo: string) => ["jira-link", repo] as const;

/**
 * `keepPreviousData` scoped to a single repo (the Jira twin of git/queries.ts's, kept local
 * so this module doesn't depend on it). Panels stay mounted across repo switches, so plain
 * keepPreviousData would flash the previous repo's Jira issue — keep previous data only
 * when the previous query was for the SAME repo (repo at query-key index 1).
 */
function keepPreviousDataForRepo(repo: string, repoKeyIndex = 1) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined =>
    previousQuery?.queryKey?.[repoKeyIndex] === repo ? previousData : undefined;
}

/** This repo's Jira link (or `null` when unlinked). */
export function useJiraLink(repo: string) {
  return useQuery({
    queryKey: jiraLinkKey(repo),
    queryFn: () => getJiraLink(repo),
  });
}

/** Invalidate the link query AND every Jira issue-list/issue-detail query for this repo.
 *  Re-linking to a different project mints new keys, but the OLD keys' caches would linger
 *  (up to staleTime) and could be served on a same-identity re-link — the predicate sweep
 *  over both issue namespaces drops them. */
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

/**
 * Narrow reconciliation for a single-issue PROPERTY write (due date, priority, labels,
 * comment create/edit/delete): just that issue's detail key plus the repo's jira-issues
 * LIST keys (lists render priority/due/labels). It deliberately leaves the link key and the
 * rest of the jira-issue namespace alone — a property write on one issue can't affect
 * another's detail. Reserve {@link invalidateJiraForRepo} for writes that change list
 * membership (create, transition, assign).
 */
function invalidateJiraIssue(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
  link: JiraLink | null | undefined,
  issueKey: string,
) {
  if (link) {
    queryClient.invalidateQueries({
      queryKey: jiraIssueDetailKey(repo, link.siteHost, issueKey),
    });
  }
  queryClient.invalidateQueries({
    queryKey: ["repo", repo, "jira-issues"],
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
    // Site + project are in the key so a re-link to a different project/site is a distinct
    // cache entry, never served the prior project's list. `?? ""` keeps the key stable
    // while `link` is absent (the query is disabled then).
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
    // Repo-scoped: panels persist across repo switches, so don't flash the previous repo's
    // issue. The site/query-keyed hooks below keep plain keepPreviousData.
    placeholderData: keepPreviousDataForRepo(repo),
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

// ── Write path ───────────────────────────────────────────────────────────────

/** The detail-cache key for one issue — must match `useJiraIssue`'s key exactly
 *  so optimistic patches and reads land on the same entry. */
const jiraIssueDetailKey = (repo: string, site: string, key: string) =>
  ["repo", repo, "jira-issue", site, key] as const;

/** The linked project's write permissions (server-resolved). Permissions change rarely, so
 *  a generous staleTime keeps this off the hot path. A failed probe surfaces as `isError`
 *  with `data === undefined`, and gates read `data?.<flag> ?? false` — a failure treats
 *  every write as not-permitted without touching the read path. */
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

/** The site's priority scheme, for the priority picker. Lazy (`enabled` = the menu being
 *  open) so nothing loads on mount. Priorities are site-global, not per-project, so the key
 *  is the site alone with a generous staleTime. */
export function useJiraPriorities(
  link: JiraLink | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["jira-priorities", link?.siteHost ?? ""] as const,
    queryFn: () => jiraPriorities((link as JiraLink).siteHost),
    enabled: !!link && enabled,
    staleTime: 5 * 60_000,
  });
}

/** All labels known to the site (first page), for the labels editor. Fetched
 *  lazily on `enabled` (the labels popover being open); the caller filters
 *  client-side. Site-global, so keyed on the site alone. */
export function useJiraLabels(
  link: JiraLink | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["jira-labels", link?.siteHost ?? ""] as const,
    queryFn: () => jiraLabels((link as JiraLink).siteHost),
    enabled: !!link && enabled,
    staleTime: 5 * 60_000,
  });
}

/** Add a comment. The server assigns the id + timestamp, so — unlike the transition patch —
 *  there's nothing to show until it resolves: the returned comment is appended to the
 *  detail cache on success, and the repo's Jira caches reconcile on settle. */
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
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** The available workflow transitions from an issue's current status, for the full status
 *  picker. Lazy (`enabled` = the status menu being open). Site is in the key so a re-link
 *  can't serve the prior site's transitions for the same key. */
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

/** Optimistically flip an issue's status category (and name when known) across the detail
 *  cache AND every jira-issues list cache for this repo, so the chip and any visible row
 *  update instantly. Shared by both transition mutations; `name === undefined` (the
 *  directional path can't know the per-workflow target name) leaves the existing name. */
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

/** Close/reopen via a directional workflow transition. Optimistic across the detail + every
 *  list cache, with rollback on error. The list patch may drop a row out of the active state
 *  filter (closing while viewing Open) — fine: the detail view stays put and settle-time
 *  invalidation reconciles the list. */
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

/** Apply a specific transition by id (the full status picker). Same plumbing as
 *  {@link useJiraTransition}, but the caller knows the target from the chosen option, so
 *  category AND name flip up front; the server's real values still land on success. */
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
      if (!link) return undefined;
      // Assignee shows on the detail and every list row; the shared helper gives
      // field-scoped rollback (never reverts a concurrent field edit on the same issue).
      return applyOptimisticField(
        queryClient,
        repo,
        link,
        args.issueKey,
        { assignee: args.assignee },
        { assignee: args.assignee },
      );
    },
    onError: (_e, _args, ctx) => rollbackOptimisticField(queryClient, ctx),
    onSettled: () => invalidateJiraForRepo(queryClient, repo),
  });
}

/** The shared optimistic context for a field patch (detail snapshot + every
 *  patched list cache), so rollback restores exactly what onMutate touched.
 *  Mirrors `useJiraAssign`'s context. */
type FieldPatchCtx = {
  detailKey: readonly unknown[] | null;
  /** Only the detail fields this patch changed (not the whole snapshot), so a
   *  rollback restores exactly those and leaves a concurrent field edit intact. */
  prevFields: Partial<JiraIssueDetails> | undefined;
  /** The patched issue's key — used to find its row when rolling back the lists. */
  issueKey: string;
  /** Per jira-issues list cache, the affected row's PRIOR values for just the patched
   *  fields (`undefined` when the row wasn't present) — field-scoped like the detail
   *  snapshot, so a rollback never reverts a concurrent sibling mutation's row update. */
  listPrev: [readonly unknown[], Partial<JiraIssueInfo> | undefined][];
};

/** Optimistically patch a set of detail fields, and (for the fields the list row also
 *  carries) the matching row in every jira-issues list cache for this repo. `listPatch` is
 *  separate from `detailPatch` because a detail-only field (due date) has no list-row
 *  counterpart. Snapshots for rollback. */
async function applyOptimisticField(
  queryClient: ReturnType<typeof useQueryClient>,
  repo: string,
  link: JiraLink,
  issueKey: string,
  detailPatch: Partial<JiraIssueDetails>,
  listPatch?: Partial<JiraIssueInfo>,
): Promise<FieldPatchCtx> {
  const detailKey = jiraIssueDetailKey(repo, link.siteHost, issueKey);
  await queryClient.cancelQueries({ queryKey: detailKey });
  const prevDetail = queryClient.getQueryData<JiraIssueDetails>(detailKey);
  // Snapshot ONLY the fields this patch touches (the keys of detailPatch), not
  // the whole detail, so rollback restores exactly those onto the current cache
  // and never reverts a concurrent field edit on the same issue.
  let prevFields: Partial<JiraIssueDetails> | undefined;
  if (prevDetail) {
    prevFields = {};
    for (const k of Object.keys(detailPatch) as (keyof JiraIssueDetails)[]) {
      (prevFields as Record<string, unknown>)[k as string] = prevDetail[k];
    }
    queryClient.setQueryData<JiraIssueDetails>(detailKey, {
      ...prevDetail,
      ...detailPatch,
    });
  }
  // Patch the matching row in every list cache, snapshotting only that row's prior values
  // for the patched fields. A detail-only field has no listPatch, so listPrev stays empty.
  const listPrev: [readonly unknown[], Partial<JiraIssueInfo> | undefined][] =
    [];
  if (listPatch) {
    const lists = queryClient.getQueriesData<JiraIssueInfo[]>({
      predicate: (q) =>
        q.queryKey[0] === "repo" &&
        q.queryKey[1] === repo &&
        q.queryKey[2] === "jira-issues",
    });
    const patchKeys = Object.keys(listPatch) as (keyof JiraIssueInfo)[];
    for (const [listKey, list] of lists) {
      if (!list) continue;
      const row = list.find((i) => i.key === issueKey);
      let prevRow: Partial<JiraIssueInfo> | undefined;
      if (row) {
        prevRow = {};
        for (const k of patchKeys) {
          (prevRow as Record<string, unknown>)[k as string] = row[k];
        }
      }
      listPrev.push([listKey, prevRow]);
      queryClient.setQueryData<JiraIssueInfo[]>(
        listKey,
        list.map((i) => (i.key === issueKey ? { ...i, ...listPatch } : i)),
      );
    }
  }
  return { detailKey, prevFields, issueKey, listPrev };
}

/** Restore the detail + list caches from a FieldPatchCtx (rollback on error).
 *  Both restores are field-scoped (only the patched keys) and merged onto the
 *  CURRENT cache, so a concurrent field edit on the same issue — in the detail
 *  OR in a list row — survives the rollback. */
function rollbackOptimisticField(
  queryClient: ReturnType<typeof useQueryClient>,
  ctx: FieldPatchCtx | undefined,
) {
  if (ctx?.detailKey && ctx.prevFields) {
    queryClient.setQueryData<JiraIssueDetails>(ctx.detailKey, (cur) =>
      cur ? { ...cur, ...ctx.prevFields } : cur,
    );
  }
  const issueKey = ctx?.issueKey;
  for (const [listKey, prevRow] of ctx?.listPrev ?? []) {
    if (!prevRow || issueKey === undefined) continue;
    queryClient.setQueryData<JiraIssueInfo[]>(listKey, (cur) =>
      cur
        ? cur.map((i) => (i.key === issueKey ? { ...i, ...prevRow } : i))
        : cur,
    );
  }
}

/** Set/clear the issue's due date. Optimistic: patches the detail cache (the due
 *  date isn't carried on the list row, so no list patch) with rollback. */
export function useJiraSetDueDate(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; dueDate: string | null }) =>
      jiraIssueSetDueDate(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.dueDate,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      return applyOptimisticField(queryClient, repo, link, args.issueKey, {
        dueDate: args.dueDate,
      });
    },
    onError: (_e, _args, ctx) => rollbackOptimisticField(queryClient, ctx),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Set the issue's priority. Optimistic: patches the priority NAME onto the detail
 *  cache and the matching list row (both carry `priorityName`) with rollback. The
 *  caller passes the chosen name so the chip updates instantly. */
export function useJiraSetPriority(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      priorityId: string;
      priorityName: string;
    }) =>
      jiraIssueSetPriority(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.priorityId,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      return applyOptimisticField(
        queryClient,
        repo,
        link,
        args.issueKey,
        { priorityName: args.priorityName },
        { priorityName: args.priorityName },
      );
    },
    onError: (_e, _args, ctx) => rollbackOptimisticField(queryClient, ctx),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Replace the issue's labels wholesale. Optimistic: patches the label array onto
 *  the detail cache and the matching list row (both carry `labels`) with rollback. */
export function useJiraSetLabels(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; labels: string[] }) =>
      jiraIssueSetLabels(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.labels,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      return applyOptimisticField(
        queryClient,
        repo,
        link,
        args.issueKey,
        { labels: args.labels },
        { labels: args.labels },
      );
    },
    onError: (_e, _args, ctx) => rollbackOptimisticField(queryClient, ctx),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Edit one of the viewer's own comments. Optimistic: patches the body and a provisional
 *  `updatedAt` in place; the server's real comment lands on success and rollback restores
 *  the prior array. Comments aren't on the list row, so no list patch. */
export function useJiraCommentEdit(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      commentId: string;
      bodyMd: string;
    }) =>
      jiraCommentEdit(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.commentId,
        args.bodyMd,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      const detailKey = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const prevDetail = queryClient.getQueryData<JiraIssueDetails>(detailKey);
      if (prevDetail) {
        const now = new Date().toISOString();
        queryClient.setQueryData<JiraIssueDetails>(detailKey, {
          ...prevDetail,
          comments: prevDetail.comments.map((c) =>
            c.id === args.commentId
              ? { ...c, bodyMd: args.bodyMd, updatedAt: now }
              : c,
          ),
        });
      }
      return { detailKey, prevDetail };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.detailKey && ctx.prevDetail !== undefined) {
        queryClient.setQueryData(ctx.detailKey, ctx.prevDetail);
      }
    },
    onSuccess: (comment, args) => {
      if (!link) return;
      const detailKey = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);
      queryClient.setQueryData<JiraIssueDetails>(detailKey, (d) =>
        d
          ? {
              ...d,
              comments: d.comments.map((c: JiraComment) =>
                c.id === comment.id ? comment : c,
              ),
            }
          : d,
      );
    },
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Delete one of the viewer's own comments. Optimistic: removes the comment from
 *  the detail cache immediately; rollback restores it on error. */
export function useJiraCommentDelete(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; commentId: string }) =>
      jiraCommentDelete(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.commentId,
      ),
    onMutate: async (args) => {
      if (!link) return undefined;
      const detailKey = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);
      await queryClient.cancelQueries({ queryKey: detailKey });
      const prevDetail = queryClient.getQueryData<JiraIssueDetails>(detailKey);
      if (prevDetail) {
        queryClient.setQueryData<JiraIssueDetails>(detailKey, {
          ...prevDetail,
          comments: prevDetail.comments.filter((c) => c.id !== args.commentId),
        });
      }
      return { detailKey, prevDetail };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.detailKey && ctx.prevDetail !== undefined) {
        queryClient.setQueryData(ctx.detailKey, ctx.prevDetail);
      }
    },
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
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

// ── Time tracking (estimates + worklogs) ─────────────────────────────────────
// Jira DERIVES every time-tracking value server-side — adding a worklog decrements the
// remaining estimate, deleting one restores it, setting an original with no worklogs
// initializes remaining, clearing an original while worklogs exist snaps original :=
// remaining. Those derivations can't be reconstructed client-side, so these five mutations
// are deliberately NON-optimistic: `invalidateJiraIssue` on settle re-fetches server truth
// and the mutation's own `isPending` drives the busy state.

/** Set/clear the issue's original estimate. Non-optimistic (server-derived) —
 *  see the section note above. */
export function useJiraSetOriginalEstimate(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; estimate: string | null }) =>
      jiraIssueSetOriginalEstimate(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.estimate,
      ),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Set/clear the issue's remaining estimate. Non-optimistic (server-derived). */
export function useJiraSetRemainingEstimate(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; estimate: string | null }) =>
      jiraIssueSetRemainingEstimate(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.estimate,
      ),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Log work against the issue. Non-optimistic — Jira decrements the remaining
 *  estimate and mints the worklog id/timestamps server-side, so we re-fetch. */
export function useJiraLogWork(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      timeSpent: string;
      commentMd?: string;
    }) =>
      jiraWorklogAdd(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.timeSpent,
        args.commentMd,
      ),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Update one of the viewer's own worklogs. Non-optimistic. `commentMd`
 *  null/undefined leaves the note unchanged; a non-empty string replaces it (the
 *  caller must never pass `""` — the backend rejects it). */
export function useJiraUpdateWorklog(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      issueKey: string;
      worklogId: string;
      timeSpent: string;
      commentMd?: string | null;
    }) =>
      jiraWorklogUpdate(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.worklogId,
        args.timeSpent,
        args.commentMd,
      ),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}

/** Delete one of the viewer's own worklogs. Non-optimistic — Jira restores the
 *  remaining estimate server-side, so we re-fetch. */
export function useJiraDeleteWorklog(
  repo: string,
  link: JiraLink | null | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { issueKey: string; worklogId: string }) =>
      jiraWorklogDelete(
        (link as JiraLink).siteHost,
        args.issueKey,
        args.worklogId,
      ),
    onSettled: (_d, _e, args) =>
      invalidateJiraIssue(queryClient, repo, link, args.issueKey),
  });
}
