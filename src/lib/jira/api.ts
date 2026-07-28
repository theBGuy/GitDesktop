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
  JiraPriority,
  JiraProject,
  JiraStoredAccount,
  JiraTransition,
  JiraTransitionDirection,
  JiraTransitionResult,
  JiraWorklog,
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

// ── Write path ──────────────────────────────────────────────────────────────

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

/** The workflow transitions available from the issue's current status (for the
 *  full status picker). Each carries the status it lands on so the menu can label
 *  + dot-tone by target status and flip the chip optimistically on select. */
export const jiraIssueTransitions = (site: string, key: string) =>
  invoke<JiraTransition[]>("jira_issue_transitions", { site, key });

/** Apply a specific transition by id (the full status picker's counterpart to the
 *  directional `jiraIssueTransition`); returns the resulting real status name +
 *  category to update the chip. */
export const jiraIssueTransitionTo = (
  site: string,
  key: string,
  transitionId: string,
) =>
  invoke<JiraTransitionResult>("jira_issue_transition_to", {
    site,
    key,
    transitionId,
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

// ── Write path: due date · priority · labels · comment edit/delete ────────────

/** The site's priority scheme (`/priority`), for the priority picker. */
export const jiraPriorities = (site: string) =>
  invoke<JiraPriority[]>("jira_priorities", { site });

/** All labels known to the site (first page); the caller filters client-side. */
export const jiraLabels = (site: string) =>
  invoke<string[]>("jira_labels", { site });

/** Set (`"YYYY-MM-DD"`) or clear (`null`) the issue's due date. */
export const jiraIssueSetDueDate = (
  site: string,
  key: string,
  dueDate: string | null,
) => invoke<void>("jira_issue_set_due_date", { site, key, dueDate });

/** Set the issue's priority by id. */
export const jiraIssueSetPriority = (
  site: string,
  key: string,
  priorityId: string,
) => invoke<void>("jira_issue_set_priority", { site, key, priorityId });

/** Replace the issue's labels wholesale (Jira has no add/remove delta API). */
export const jiraIssueSetLabels = (
  site: string,
  key: string,
  labels: string[],
) => invoke<void>("jira_issue_set_labels", { site, key, labels });

/** Edit one of the viewer's own comments (markdown → ADF Rust-side); returns the
 *  updated comment with its body back as markdown. */
export const jiraCommentEdit = (
  site: string,
  key: string,
  commentId: string,
  bodyMd: string,
) => invoke<JiraComment>("jira_comment_edit", { site, key, commentId, bodyMd });

/** Delete one of the viewer's own comments. */
export const jiraCommentDelete = (
  site: string,
  key: string,
  commentId: string,
) => invoke<void>("jira_comment_delete", { site, key, commentId });

// ── Write path: time tracking (estimates + worklogs) ──────────────────────────
// Jira DERIVES these values server-side (adding a worklog decrements remaining,
// setting original initializes remaining, …), so — unlike the field writes
// above — the frontend does NOT patch optimistically; it re-fetches the issue.

/** Set (`"2d"`) or clear (`null`) the issue's original estimate. Clearing while
 *  worklogs exist snaps the original to the current remaining (server behavior). */
export const jiraIssueSetOriginalEstimate = (
  site: string,
  key: string,
  estimate: string | null,
) => invoke<void>("jira_issue_set_original_estimate", { site, key, estimate });

/** Set (`"1d"`) or clear (`null`) the issue's remaining estimate. */
export const jiraIssueSetRemainingEstimate = (
  site: string,
  key: string,
  estimate: string | null,
) => invoke<void>("jira_issue_set_remaining_estimate", { site, key, estimate });

/** Log work against the issue; returns the created worklog. `commentMd` optional
 *  (a note); omit/empty leaves the entry noteless. Jira decrements the remaining
 *  estimate server-side, so the caller re-fetches rather than patches. */
export const jiraWorklogAdd = (
  site: string,
  key: string,
  timeSpent: string,
  commentMd?: string,
) =>
  invoke<JiraWorklog>("jira_worklog_add", { site, key, timeSpent, commentMd });

/** Update one of the viewer's own worklogs; returns the updated worklog.
 *  `commentMd` semantics: `null`/`undefined` leaves the note UNCHANGED; a
 *  non-empty string replaces it. An empty string is REJECTED by the backend
 *  (Jira can't remove a note), so the caller must never send `""`. */
export const jiraWorklogUpdate = (
  site: string,
  key: string,
  worklogId: string,
  timeSpent: string,
  commentMd?: string | null,
) =>
  invoke<JiraWorklog>("jira_worklog_update", {
    site,
    key,
    worklogId,
    timeSpent,
    commentMd,
  });

/** Delete one of the viewer's own worklogs (Jira restores the remaining
 *  estimate server-side). */
export const jiraWorklogDelete = (
  site: string,
  key: string,
  worklogId: string,
) => invoke<void>("jira_worklog_delete", { site, key, worklogId });
