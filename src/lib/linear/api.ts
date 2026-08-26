import { invoke } from "@/lib/tauri/invoke";
import { COLD_START } from "@/lib/test-mode";
import type {
  LinearAccountInfo,
  LinearComment,
  LinearCreatedIssue,
  LinearIssueDetails,
  LinearIssueInfo,
  LinearIssueState,
  LinearStoredAccount,
  LinearTeam,
} from "./types";

// Thin wrappers over the `linear.rs` command family. The Linear personal API
// token lives in the OS keychain; the raw token never crosses IPC — the set
// command validates against the API and returns account info, never the token.
// The link config (teamKey) is read from app-data by the frontend (see
// store.ts) and passed into the data commands, keeping Rust stateless about
// linkage.

/** Validate a personal API token against Linear's viewer query without
 *  persisting it. Throws with a human message on a bad/expired token. */
export const linearValidateToken = (token: string) =>
  invoke<LinearAccountInfo>("linear_validate_token", { token });

/** Validate and persist the token. Throws (nothing saved) on a bad token. */
export const linearSetAccount = (token: string) =>
  invoke<LinearAccountInfo>("linear_set_account", { token });

/** The stored account (fast keyring check, no network); `null` when none.
 *  Cold-start test mode has no keychain, so reports "not connected". */
export const linearStoredAccount = () =>
  COLD_START
    ? Promise.resolve<LinearStoredAccount | null>(null)
    : invoke<LinearStoredAccount | null>("linear_stored_account");

/** Remove the saved Linear credential from the keychain. */
export const linearClearAccount = () => invoke<void>("linear_clear_account");

/** The viewer's teams (for the link picker). */
export const linearTeams = () => invoke<LinearTeam[]>("linear_teams");

/** One bounded page of a team's issues, filtered by state. */
export const linearIssueList = (teamKey: string, state: LinearIssueState) =>
  invoke<LinearIssueInfo[]>("linear_issue_list", { teamKey, state });

/** The full read-only detail for one issue (description + comments as markdown). */
export const linearIssueView = (identifier: string) =>
  invoke<LinearIssueDetails>("linear_issue_view", { identifier });

/** Add a comment (markdown); returns the created comment. */
export const linearIssueComment = (issueId: string, bodyMd: string) =>
  invoke<LinearComment>("linear_issue_comment", { issueId, bodyMd });

/** Create an issue; returns the new identifier + URL. `descriptionMd` optional. */
export const linearIssueCreate = (
  teamId: string,
  title: string,
  descriptionMd?: string,
) =>
  invoke<LinearCreatedIssue>("linear_issue_create", {
    teamId,
    title,
    descriptionMd,
  });

/** Transition an issue to a different workflow state by state id. */
export const linearIssueTransition = (issueId: string, stateId: string) =>
  invoke<void>("linear_issue_transition", { issueId, stateId });

/** Assign (userId) or unassign (null) the issue's single assignee. */
export const linearIssueAssign = (issueId: string, assigneeId: string | null) =>
  invoke<void>("linear_issue_assign", { issueId, assigneeId });
