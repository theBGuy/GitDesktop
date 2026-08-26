import type { ForgeUserRef } from "@/lib/git/types";

// TS mirrors of the Rust `linear.rs` command shapes. Linear is a per-repo
// *linked* issue provider (like Jira) — never a git host — so these types live
// in their own module. Issue identity is the human identifier (`ENG-123`) as a
// string end-to-end.

export interface LinearAccountInfo {
  name: string;
  email: string;
  id: string;
}

export interface LinearStoredAccount {
  email: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export type LinearIssueState = "open" | "closed" | "all";

export interface LinearIssueInfo {
  identifier: string;
  title: string;
  statusName: string;
  /** "backlog"|"unstarted"|"started"|"completed"|"cancelled" */
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

export interface LinearComment {
  id: string;
  bodyMd: string;
  author: ForgeUserRef | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface LinearIssueDetails extends LinearIssueInfo {
  id: string;
  descriptionMd: string;
  comments: LinearComment[];
  viewerId: string | null;
}

export interface LinearCreatedIssue {
  identifier: string;
  url: string;
}
