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

/** A reference to an issue's parent, as surfaced by the agile fields. Jira's
 *  `parent` field is the unified epic/parent reference — the dedicated "Epic
 *  Link" custom field was removed from the REST API in 2025, so `parent` is the
 *  single source for both an epic link and a subtask's parent story. */
export interface JiraParentRef {
  key: string;
  summary: string;
}

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
  // ── Agile fields (phase 4, read-only) ──────────────────────────────────────
  // Resolved lazily from per-site custom fields on the backend; every one is
  // null/empty on a site without agile fields, so all UI omits-when-empty.
  /** Story-points estimate; `null` when unset or the site has no points field. */
  storyPoints: number | null;
  /** Active/upcoming sprint name; `null` when the issue is in no sprint. */
  sprintName: string | null;
  /** The sprint's state, e.g. "active" | "future" — a display-only string. */
  sprintState: string | null;
  /** The unified epic/parent reference; `null` when the issue has no parent. */
  parent: JiraParentRef | null;
  /** Component names attached to the issue (empty when none). */
  components: string[];
  /** Fix-version names attached to the issue (empty when none). */
  fixVersions: string[];
}

/** Format a story-points value for display: whole numbers without a decimal
 *  (`3`, not `3.0`), non-integers to one decimal (`2.5`). Shared by the list
 *  row pill and the detail meta row so the two never diverge. */
export function formatStoryPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
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

// ── Write path (phase 2) ────────────────────────────────────────────────────

/** Per-project write permissions for the linked project, resolved server-side
 *  (Jira's `mypermissions`). Each flag gates one affordance: permitted → the
 *  control renders; not permitted (or a failed probe — every flag defaults
 *  false) → the control is ABSENT, never disabled. */
export interface JiraPermissions {
  addComments: boolean;
  transitionIssues: boolean;
  createIssues: boolean;
  assignIssues: boolean;
}

/** An issue type for the create picker (`createmeta`); `subtask` types are
 *  filtered out — a subtask can't be created standalone. */
export interface JiraIssueType {
  id: string;
  name: string;
  iconUrl: string;
  subtask: boolean;
}

/** The result of a close/reopen transition: the issue's new real status name +
 *  category, applied to the chip so it reflects the workflow's actual target
 *  status (e.g. "Done"), never a generic "Closed". */
export interface JiraTransitionResult {
  statusName: string;
  statusCategory: JiraStatusCategory;
}

/** The direction of a workflow transition: `close` picks a transition whose
 *  target category is `done`; `reopen` picks one targeting `new`/`indeterminate`. */
export type JiraTransitionDirection = "close" | "reopen";

/** One available workflow transition from the issue's current status, as offered
 *  by the full status picker. `name` is the transition's own name; `toStatusName`
 *  / `toStatusCategory` describe the status it lands on (what the menu labels and
 *  dot-tones by, and what the chip flips to optimistically on select). */
export interface JiraTransition {
  id: string;
  name: string;
  toStatusName: string;
  toStatusCategory: JiraStatusCategory;
}

/** The result of creating an issue: the new key + its browser URL. */
export interface JiraCreatedIssue {
  key: string;
  url: string;
}
