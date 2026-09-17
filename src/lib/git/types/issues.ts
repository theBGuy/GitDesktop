import type { ForgeUserRef, RepoLabel } from "./forge";
import type { PrThreadOut } from "./pr-reviews";

/** A GitLab issue/MR's time-tracking summary. Seconds are the raw values; the
 *  human strings are GitLab's own formatting ("3h", "1d 2h") and are "" when the
 *  matching value is unset. GitLab-only (`implemented.timeTracking`). */
export interface GitLabTimeStats {
  /** Estimate, in seconds (0 when unset). */
  timeEstimate: number;
  /** Total time spent, in seconds (0 when unset). */
  totalTimeSpent: number;
  /** Human estimate ("3h"); "" when unset. */
  humanTimeEstimate: string;
  /** Human total spent ("1d 2h"); "" when unset. */
  humanTotalTimeSpent: string;
}

/** A related issue linked to another via a `relates_to` link. GitLab-only
 *  (`implemented.issueLinks`); `linkId` addresses the link for removal. */
export interface GitLabLinkedIssue {
  /** The link's own id (used to unlink), as a string (IPC-safe). */
  linkId: string;
  number: number;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  /** "relates_to" (the only link type the app creates). */
  linkType: string;
  webUrl: string;
}

export interface IssueInfo {
  number: number;
  url: string;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { name: string }[];
}

export interface Milestone {
  number: number;
  title: string;
}

/** An org-defined issue type (Bug/Feature/Task/…). */
export interface IssueType {
  id: string;
  name: string;
  /** GitHub color NAME (GRAY/BLUE/GREEN/YELLOW/ORANGE/RED/PINK/PURPLE). */
  color: string;
}

/** One issue in a parent/sub-issue relationship. */
export interface RelatedIssue {
  /** GraphQL node id (used to remove the relationship). */
  id: string;
  number: number;
  title: string;
  /** "OPEN" or "CLOSED". */
  state: string;
  url: string;
}

/** An issue's parent and sub-issues, with the completion summary. */
export interface IssueRelations {
  parent: RelatedIssue | null;
  subIssues: RelatedIssue[];
  completed: number;
  total: number;
}

/** An issue's dependencies: issues blocking it, and issues it blocks. */
export interface IssueDependencies {
  blockedBy: RelatedIssue[];
  blocking: RelatedIssue[];
}

/** Which dependency direction to edit. */
export type IssueRelation = "blocked_by" | "blocking";

/** A pull request linked to an issue (it closes / references it). */
export interface LinkedPr {
  number: number;
  title: string;
  /** "OPEN", "CLOSED", or "MERGED". */
  state: string;
  url: string;
}

/** An issue's "Development" links: closing PRs + linked branches. */
export interface IssueDevelopment {
  prs: LinkedPr[];
  branches: string[];
}

export interface IssueDetails {
  /** GraphQL node id, used by the label mutations. */
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  /** The author's avatar URL when the provider supplies one (GitLab). Empty for
   *  GitHub, where it's login-derived on the frontend. */
  authorAvatarUrl: string;
  state: string;
  createdAt: string;
  url: string;
  /** Assignees (GitHub + GitLab). Each carries an avatar (GitLab supplies it;
   *  GitHub is login-derived). */
  assignees: ForgeUserRef[];
  milestone: Milestone | null;
  issueType: IssueType | null;
  isPinned: boolean;
  locked: boolean;
  /** GitHub's lock reason (off_topic/resolved/spam/too_heated) or null. */
  activeLockReason: string | null;
  /** GitLab-only: the issue is hidden from non-members. Always false on GitHub. */
  confidential: boolean;
  /** GitLab-only: "YYYY-MM-DD" or null. GitHub issues have no due dates. */
  dueDate: string | null;
  /** Conversation comments (shared shape with PRs). */
  comments: PrThreadOut[];
  labels: RepoLabel[];
}
