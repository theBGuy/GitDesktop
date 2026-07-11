import type { ForgeUserRef } from "@/lib/git/types";

// TS mirrors of the Rust `jira.rs` command shapes (frozen contract). Jira is a
// per-repo *linked* issue provider — never a git host — so these types live in
// their own module and never touch `IssueInfo`/`IssueDetails` or the
// `forge_issue_*` surface. Issue identity is the human key (`PROJ-123`) as a
// string end-to-end; internal numeric ids, where surfaced, travel as strings.

/** The account resolved by validating (site, email, token) against `/myself`.
 *  Never carries the token. */
export interface JiraAccountInfo {
  displayName: string;
  accountId: string;
  avatarUrl: string;
  email: string;
}

/** The stored account for a site (fast keyring check, no network); `null` when
 *  no credential is saved for that site. */
export interface JiraStoredAccount {
  email: string;
}

/** A project row for the link picker (`project/search`). */
export interface JiraProject {
  id: string;
  key: string;
  name: string;
  avatarUrl: string;
}

/** Jira's `status.statusCategory.key`. `done` maps to the app's closed/merged
 *  chip treatment; everything else (including `""` when an issue has no
 *  category — the Rust extractor falls back to an empty string) to the
 *  open/success treatment. */
export type JiraStatusCategory = "new" | "indeterminate" | "done" | "";

/** The open/closed/all filter, mapped through `statusCategory` on the backend. */
export type JiraIssueState = "open" | "closed" | "all";

/** A Jira issue as it appears in the list (one page, `maxResults` bounded). */
export interface JiraIssueInfo {
  key: string;
  summary: string;
  /** The real status name, e.g. "In Review" — the meaning shown as chip text. */
  statusName: string;
  statusCategory: JiraStatusCategory;
  issueTypeName: string;
  issueTypeIconUrl: string;
  priorityName: string;
  assignee: ForgeUserRef | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** One comment on a Jira issue, body already converted ADF → markdown. */
export interface JiraComment {
  id: string;
  author: ForgeUserRef | null;
  bodyMd: string;
  createdAt: string;
}

/** The full read-only detail for one Jira issue (list fields + description,
 *  reporter, comments, due date, resolution). */
export interface JiraIssueDetails extends JiraIssueInfo {
  reporter: ForgeUserRef | null;
  dueDate: string | null;
  resolutionName: string | null;
  /** Description body, already converted ADF → markdown. */
  descriptionMd: string;
  comments: JiraComment[];
}
