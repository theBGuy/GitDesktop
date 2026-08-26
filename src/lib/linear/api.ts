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

// Thin wrappers over the `linear.rs` command family. Linear credentials live
// in the OS keychain under `forge/linear.app/token`; the raw token never
// crosses IPC.

export const linearValidateToken = (token: string) =>
  invoke<LinearAccountInfo>("linear_validate_token", { token });

export const linearSetAccount = (token: string) =>
  invoke<LinearAccountInfo>("linear_set_account", { token });

export const linearStoredAccount = () =>
  COLD_START
    ? Promise.resolve<LinearStoredAccount | null>(null)
    : invoke<LinearStoredAccount | null>("linear_stored_account");

export const linearClearAccount = () =>
  invoke<void>("linear_clear_account");

export const linearTeams = () => invoke<LinearTeam[]>("linear_teams");

export const linearIssueList = (teamKey: string, state: LinearIssueState) =>
  invoke<LinearIssueInfo[]>("linear_issue_list", { teamKey, state });

export const linearIssueView = (identifier: string) =>
  invoke<LinearIssueDetails>("linear_issue_view", { identifier });

export const linearIssueComment = (issueId: string, bodyMd: string) =>
  invoke<LinearComment>("linear_issue_comment", { issueId, bodyMd });

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

export const linearIssueTransition = (issueId: string, stateId: string) =>
  invoke<void>("linear_issue_transition", { issueId, stateId });

export const linearIssueAssign = (
  issueId: string,
  assigneeId: string | null,
) => invoke<void>("linear_issue_assign", { issueId, assigneeId });
