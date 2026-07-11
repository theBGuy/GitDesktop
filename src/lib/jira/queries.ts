import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  jiraAccount,
  jiraIssueList,
  jiraIssueView,
  jiraProjectSearch,
} from "./api";
import {
  clearJiraLink,
  getJiraLink,
  type JiraLink,
  setJiraLink,
} from "./store";
import type { JiraIssueState } from "./types";

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
