import type { ForgeUserRef } from "@/lib/git/types";
import { invoke } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";
import type {
  JiraAccountInfo,
  JiraComment,
  JiraCreatedIssue,
  JiraIssueDetails,
  JiraIssueInfo,
  JiraIssueState,
  JiraIssueType,
  JiraPermissions,
  JiraProject,
  JiraStoredAccount,
  JiraTransitionDirection,
  JiraTransitionResult,
} from "./types";

// Thin wrappers over the `jira.rs` command family. Jira credentials live in the
// OS keychain under `forge/<site-host>/{email,token}`; the raw token never
// crosses IPC — the set command validates against the site and returns account
// info, never the token. The link config (site + projectKey) is read from
// app-data by the frontend (see store.ts) and passed into the data commands,
// keeping Rust stateless about linkage.

/** Validate (site, email, token) against the site and, on success, persist the
 *  credential. Throws (nothing saved) with a human message on a bad site shape,
 *  401 (bad credential), or 403 (valid credential without access). */
export const jiraSetAccount = (site: string, email: string, token: string) =>
  invoke<JiraAccountInfo>("jira_set_account", { site, email, token });

/** One-click reuse of the stored Bitbucket credential: reads the stored Atlassian
 *  email + token Rust-side (the token never crosses IPC), probes the site's
 *  `/myself`, and persists under the site host on success. Throws with a distinct
 *  human message when no Bitbucket account is stored, on 401 (expired), or on 403
 *  (the Bitbucket token may not carry Jira access — enter a Jira token manually). */
export const jiraSetAccountFromBitbucket = (site: string) =>
  invoke<JiraAccountInfo>("jira_set_account_from_bitbucket", { site });

/** The stored account for `site` (fast keyring check, no network); `null` when
 *  none. Cold-start test mode has no keychain, so reports "not connected". */
export const jiraAccount = (site: string) =>
  COLD_START
    ? Promise.resolve<JiraStoredAccount | null>(null)
    : invoke<JiraStoredAccount | null>("jira_account", { site });

/** Remove the saved credential for `site` from the keychain. */
export const jiraClearAccount = (site: string) =>
  invoke<void>("jira_clear_account", { site });

/** Re-probe the site with the stored credential (e.g. to surface an expired
 *  token as a routine state). Returns the resolved account. */
export const jiraValidate = (site: string) =>
  invoke<JiraAccountInfo>("jira_validate", { site });

/** Search the site's projects for the link picker (`project/search`). */
export const jiraProjectSearch = (site: string, query: string) =>
  invoke<JiraProject[]>("jira_project_search", { site, query });

/** One bounded page of the linked project's issues, filtered by state through
 *  `statusCategory`. */
export const jiraIssueList = (
  site: string,
  projectKey: string,
  state: JiraIssueState,
) => invoke<JiraIssueInfo[]>("jira_issue_list", { site, projectKey, state });

/** The full read-only detail for one issue (description + comments as markdown). */
export const jiraIssueView = (site: string, key: string) =>
  invoke<JiraIssueDetails>("jira_issue_view", { site, key });

// ── Write path (phase 2) ────────────────────────────────────────────────────

/** The linked project's per-project write permissions (server-resolved). Every
 *  flag gates one affordance; a failed probe should be treated as all-false by
 *  the caller (absent affordances) so the read path is never blocked. */
export const jiraPermissions = (site: string, projectKey: string) =>
  invoke<JiraPermissions>("jira_permissions", { site, projectKey });

/** The project's creatable issue types (`createmeta`); subtasks are included —
 *  the caller filters them out. */
export const jiraIssueTypes = (site: string, projectKey: string) =>
  invoke<JiraIssueType[]>("jira_issue_types", { site, projectKey });

/** Add a comment (markdown → ADF Rust-side); returns the created comment with
 *  its body already converted back to markdown. */
export const jiraIssueComment = (site: string, key: string, bodyMd: string) =>
  invoke<JiraComment>("jira_issue_comment", { site, key, bodyMd });

/** Close or reopen the issue via a workflow transition; returns the resulting
 *  real status name + category to update the chip. */
export const jiraIssueTransition = (
  site: string,
  key: string,
  direction: JiraTransitionDirection,
) =>
  invoke<JiraTransitionResult>("jira_issue_transition", {
    site,
    key,
    direction,
  });

/** Create an issue; returns the new key + URL. `descriptionMd` optional (empty
 *  becomes a single ADF paragraph Rust-side). */
export const jiraIssueCreate = (
  site: string,
  projectKey: string,
  issueTypeId: string,
  summary: string,
  descriptionMd?: string,
) =>
  invoke<JiraCreatedIssue>("jira_issue_create", {
    site,
    projectKey,
    issueTypeId,
    summary,
    descriptionMd,
  });

/** Assign (accountId) or unassign (null) the issue's single assignee. */
export const jiraIssueAssign = (
  site: string,
  key: string,
  accountId: string | null,
) => invoke<void>("jira_issue_assign", { site, key, accountId });

/** Search assignable users for the issue (Jira scopes the search to the issue's
 *  project + permissions). Returns neutral `ForgeUserRef`s carrying the API
 *  avatar URL. */
export const jiraUserSearch = (site: string, key: string, query: string) =>
  invoke<ForgeUserRef[]>("jira_user_search", { site, key, query });
