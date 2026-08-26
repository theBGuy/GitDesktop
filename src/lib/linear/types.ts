import type { ForgeUserRef } from "@/lib/git/types";

// TS mirrors of the Rust `linear.rs` command shapes (frozen contract). Linear is
// a per-repo *linked* issue provider — never a git host — so these types live in
// their own module and never touch `IssueInfo`/`IssueDetails` or the
// `forge_issue_*` surface. Issue identity is the human identifier (`ENG-123`) as
// a string end-to-end; internal UUIDs, where surfaced, travel as strings.

/** The account resolved by validating a personal API token against Linear's
 *  `/viewer` query. Never carries the token. */
export interface LinearAccountInfo {
  name: string;
  email: string;
  id: string;
}

/** The stored account (fast keyring check, no network); `null` when no
 *  credential is saved. */
export interface LinearStoredAccount {
  email: string;
}

/** A team row for the link picker. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** The open/closed/all filter, mapped through `statusType` on the backend. */
export type LinearIssueState = "open" | "closed" | "all";

/** A Linear issue as it appears in the list (bounded page). */
export interface LinearIssueInfo {
  identifier: string;
  title: string;
  statusName: string;
  /** Linear's workflow state type: "backlog"|"unstarted"|"started"|"completed"|"cancelled". */
  statusType: string;
  priorityLabel: string;
  assignee: ForgeUserRef | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  estimate: number | null;
  cycleName: string | null;
  projectName: string | null;
}

/** One comment on a Linear issue, body already as markdown. */
export interface LinearComment {
  id: string;
  bodyMd: string;
  author: ForgeUserRef | null;
  createdAt: string;
  updatedAt: string | null;
}

/** The full read-only detail for one Linear issue (list fields + description,
 *  comments, viewer id). */
export interface LinearIssueDetails extends LinearIssueInfo {
  id: string;
  descriptionMd: string;
  comments: LinearComment[];
  /** The calling account's Linear user id, so the UI can recognise the viewer's
   *  own comments. `null` = unknown (hide own-comment affordances). */
  viewerId: string | null;
}

/** The result of creating an issue: the new identifier + its browser URL. */
export interface LinearCreatedIssue {
  identifier: string;
  url: string;
}
