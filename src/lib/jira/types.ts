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
  /** When the comment was last edited; `null` when never edited (or equal to
   *  `createdAt` on a pristine comment). Drives the "(edited)" cue. */
  updatedAt: string | null;
}

/** The issue's time-tracking figures, all server-derived. Jira maintains these
 *  itself (adding a worklog decrements remaining; deleting one restores it;
 *  setting an original with no worklogs initializes remaining), so the display
 *  strings are Jira's own (`"2d"`, `"1d 5h"`) and the seconds counterparts drive
 *  progress + overage math. Each field is `null` when unset. `null` for the whole
 *  object means the feature is DISABLED on the project (no section renders). */
export interface JiraTimeTracking {
  /** Jira's display string for the original estimate, e.g. "2d"; `null` unset. */
  originalEstimate: string | null;
  remainingEstimate: string | null;
  timeSpent: string | null;
  originalEstimateSeconds: number | null;
  remainingEstimateSeconds: number | null;
  timeSpentSeconds: number | null;
}

/** One worklog entry on a Jira issue. `commentMd` is `""` when the entry has no
 *  note (already converted ADF → markdown); once set, a note can only be REPLACED,
 *  never removed. `author` is `null` when Jira couldn't resolve the actor. */
export interface JiraWorklog {
  id: string;
  author: ForgeUserRef | null;
  /** Jira's display string for the logged time, e.g. "3h 30m". */
  timeSpent: string;
  timeSpentSeconds: number;
  /** When the work was performed (RFC3339). */
  started: string;
  /** The note, ADF → markdown; `""` when the entry has no note. */
  commentMd: string;
  createdAt: string;
  updatedAt: string | null;
}

/** The full read-only detail for one Jira issue (list fields + description,
 *  reporter, comments, due date, resolution, time tracking). */
export interface JiraIssueDetails extends JiraIssueInfo {
  reporter: ForgeUserRef | null;
  dueDate: string | null;
  resolutionName: string | null;
  /** Description body, already converted ADF → markdown. */
  descriptionMd: string;
  comments: JiraComment[];
  /** The calling account's accountId, so the UI can recognise the viewer's OWN
   *  comments to offer edit/delete. `null` = unknown (hide own-comment
   *  affordances); Jira still enforces ownership server-side regardless. */
  viewerAccountId: string | null;
  /** The issue's time-tracking figures, or `null` when the feature is disabled on
   *  the project — in which case the whole time-tracking section is absent. */
  timeTracking: JiraTimeTracking | null;
  /** The embedded first page of worklogs (Jira caps this at 20 server-side). */
  worklogs: JiraWorklog[];
  /** The true worklog count, which may exceed `worklogs.length` — when it does the
   *  UI offers a "View all in Jira" link-out. */
  worklogsTotal: number;
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
  /** Set the issue's due date (Jira's SCHEDULE_ISSUES permission). */
  scheduleIssues: boolean;
  /** Edit the issue's own fields (priority, labels — Jira's EDIT_ISSUES). */
  editIssues: boolean;
  /** Edit the viewer's own comments (Jira's EDIT_OWN_COMMENTS). */
  editOwnComments: boolean;
  /** Delete the viewer's own comments (Jira's DELETE_OWN_COMMENTS). */
  deleteOwnComments: boolean;
  /** Log work on the issue (Jira's WORK_ON_ISSUES). */
  workOnIssues: boolean;
  /** Edit the viewer's own worklogs (Jira's EDIT_OWN_WORKLOGS). */
  editOwnWorklogs: boolean;
  /** Delete the viewer's own worklogs (Jira's DELETE_OWN_WORKLOGS). */
  deleteOwnWorklogs: boolean;
}

/** A priority option for the priority picker (`/priority`). */
export interface JiraPriority {
  id: string;
  name: string;
  iconUrl: string;
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
