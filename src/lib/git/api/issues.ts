import { invoke } from "@/lib/tauri/invoke";
import type {
  ForgeTimelineEvent,
  ForgeUserRef,
  GitLabLinkedIssue,
  IssueDependencies,
  IssueDetails,
  IssueDevelopment,
  IssueInfo,
  IssueRelation,
  IssueRelations,
  IssueType,
  Milestone,
  PrRef,
  RemoteLens,
  RemoteListFilter,
} from "../types";

/** An issue's activity timeline (labels, assignment, milestones, cross-references,
 *  state changes) for the issue view. Provider-neutral — the backend dispatches
 *  (GitHub GraphQL, GitLab resource events + system notes; Bitbucket issues are
 *  unsupported). */
export const forgeIssueTimeline = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<ForgeTimelineEvent[]>("forge_issue_timeline", {
    repoPath,
    number,
    lens,
  });

export type IssueStateFilter = "open" | "closed";

// Provider-neutral issue reads — the backend resolves the repo's provider and
// dispatches, returning the same neutral `IssueInfo`/`IssueDetails` shapes. Most writes
// are neutral too; the GitHub-only ones keep their `gh_issue_*` names (pin/unpin, issue
// type, sub-issues/dependencies, linked branch) — trust the prefix, not this list.
export const forgeIssueList = (
  repoPath: string,
  state: IssueStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
) =>
  invoke<IssueInfo[]>("forge_issue_list", {
    repoPath,
    state,
    limit,
    lens,
    filter,
  });

export const forgeIssueView = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueDetails>("forge_issue_view", { repoPath, number, lens });

/** Create an issue. Provider-neutral: `milestone` is the provider's milestone key
 *  (whatever `forgeMilestones` returned as `number`); only `issueType` is
 *  GitHub-only and dropped by the GitLab arm (its dialog hides that picker). */
export const forgeIssueCreate = (
  repoPath: string,
  title: string,
  body: string,
  labels: string[],
  assignees: string[],
  milestone: number | null,
  issueType: string | null,
  lens: RemoteLens,
) =>
  invoke<PrRef>("forge_issue_create", {
    repoPath,
    title,
    body,
    labels,
    assignees,
    milestone,
    issueType,
    lens,
  });

export const forgeAssignableUsers = (repoPath: string, lens: RemoteLens) =>
  invoke<ForgeUserRef[]>("forge_assignable_users", { repoPath, lens });

/** Open/active milestones for the milestone picker. `number` is whatever key the
 *  provider's milestone write takes (GitHub milestone number, GitLab global id). */
export const forgeMilestones = (repoPath: string, lens: RemoteLens) =>
  invoke<Milestone[]>("forge_milestones", { repoPath, lens });

export const forgeIssueSetAssignees = (
  repoPath: string,
  number: number,
  assignees: string[],
  lens: RemoteLens,
) =>
  invoke<void>("forge_issue_set_assignees", {
    repoPath,
    number,
    assignees,
    lens,
  });

export const forgeIssueSetMilestone = (
  repoPath: string,
  number: number,
  milestone: number | null,
  lens: RemoteLens,
) =>
  invoke<void>("forge_issue_set_milestone", {
    repoPath,
    number,
    milestone,
    lens,
  });

/** Mark an issue confidential (members-only) or public — GitLab-only. */
export const forgeGlIssueSetConfidential = (
  repoPath: string,
  number: number,
  confidential: boolean,
) =>
  invoke<void>("forge_gl_issue_set_confidential", {
    repoPath,
    number,
    confidential,
  });

/** Set ("YYYY-MM-DD") or clear (null) an issue's due date — GitLab-only. */
export const forgeGlIssueSetDueDate = (
  repoPath: string,
  number: number,
  dueDate: string | null,
) => invoke<void>("forge_gl_issue_set_due_date", { repoPath, number, dueDate });

// GitLab related-issue links (relates_to) — GitLab-only, gated on
// `implemented.issueLinks`. Links are symmetric server-side.
export const forgeGlIssueLinks = (repoPath: string, number: number) =>
  invoke<GitLabLinkedIssue[]>("forge_gl_issue_links", { repoPath, number });

export const forgeGlIssueLink = (
  repoPath: string,
  number: number,
  targetNumber: number,
) => invoke<void>("forge_gl_issue_link", { repoPath, number, targetNumber });

export const forgeGlIssueUnlink = (
  repoPath: string,
  number: number,
  linkId: string,
) => invoke<void>("forge_gl_issue_unlink", { repoPath, number, linkId });

/** The repo's enabled issue types (empty when the owner defines none). */
export const ghIssueTypes = (repoPath: string, lens: RemoteLens) =>
  invoke<IssueType[]>("gh_issue_types", { repoPath, lens });

export const ghIssueSetType = (
  repoPath: string,
  number: number,
  typeName: string | null,
  lens: RemoteLens,
) => invoke<void>("gh_issue_set_type", { repoPath, number, typeName, lens });

export const ghIssuePin = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_issue_pin", { repoPath, number, lens });

export const ghIssueUnpin = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("gh_issue_unpin", { repoPath, number, lens });

export type LockReason = "off_topic" | "resolved" | "spam" | "too_heated";

/** Locks the conversation. `reason` is GitHub-only (GitLab locks without one —
 *  its arm ignores it). */
export const forgeIssueLock = (
  repoPath: string,
  number: number,
  reason: LockReason | null,
  lens: RemoteLens,
) => invoke<void>("forge_issue_lock", { repoPath, number, reason, lens });

export const forgeIssueUnlock = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_unlock", { repoPath, number, lens });

/** The repo's issue templates (frontmatter stripped); empty when it has none. */
export const readIssueTemplates = (repoPath: string) =>
  invoke<string[]>("read_issue_templates", { repoPath });

// Issue comment, close/reopen, title/body edit, lock, transfer and delete are all
// provider-neutral. The remaining GitHub-only writes keep the `gh_issue_*` prefix
// (pin/unpin, issue type, sub-issues/dependencies, linked branch).
export const forgeIssueComment = (
  repoPath: string,
  number: number,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_comment", { repoPath, number, body, lens });

export const forgeIssueClose = (
  repoPath: string,
  number: number,
  reason: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_close", { repoPath, number, reason, lens });

export const forgeIssueReopen = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_reopen", { repoPath, number, lens });

export const forgeIssueEdit = (
  repoPath: string,
  number: number,
  title: string,
  body: string,
  lens: RemoteLens,
) => invoke<void>("forge_issue_edit", { repoPath, number, title, body, lens });

/** Transfers (GitHub) / moves (GitLab) an issue to `destination` — "owner/repo"
 *  on GitHub, a full "group/name" project path on GitLab; returns the new URL. */
export const forgeIssueTransfer = (
  repoPath: string,
  number: number,
  destination: string,
  lens: RemoteLens,
) =>
  invoke<string>("forge_issue_transfer", {
    repoPath,
    number,
    destination,
    lens,
  });

export const forgeIssueDelete = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<void>("forge_issue_delete", { repoPath, number, lens });

export const ghIssueRelations = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) => invoke<IssueRelations>("gh_issue_relations", { repoPath, number, lens });

export const ghIssueDependencies = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueDependencies>("gh_issue_dependencies", {
    repoPath,
    number,
    lens,
  });

export const ghIssueDevelopment = (
  repoPath: string,
  number: number,
  lens: RemoteLens,
) =>
  invoke<IssueDevelopment>("gh_issue_development", { repoPath, number, lens });

/** Creates a new branch off the default branch, linked to the issue. */
export const ghIssueCreateLinkedBranch = (
  repoPath: string,
  issueId: string,
  name: string,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_create_linked_branch", {
    repoPath,
    issueId,
    name,
    lens,
  });

/** Adds/removes a blocked-by or blocking dependency by target issue number. */
export const ghIssueSetDependency = (
  repoPath: string,
  number: number,
  relation: IssueRelation,
  target: number,
  add: boolean,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_set_dependency", {
    repoPath,
    number,
    relation,
    target,
    add,
    lens,
  });

/** Adds issue `subNumber` (this repo) as a sub-issue of `parentId` (node id). */
export const ghIssueAddSubIssue = (
  repoPath: string,
  parentId: string,
  subNumber: number,
  lens: RemoteLens,
) =>
  invoke<void>("gh_issue_add_sub_issue", {
    repoPath,
    parentId,
    subNumber,
    lens,
  });

export const ghIssueRemoveSubIssue = (
  repoPath: string,
  parentId: string,
  subId: string,
) => invoke<void>("gh_issue_remove_sub_issue", { repoPath, parentId, subId });

export const forgeIssueEditComment = (
  repoPath: string,
  number: number,
  commentId: string,
  body: string,
) =>
  invoke<void>("forge_issue_edit_comment", {
    repoPath,
    number,
    commentId,
    body,
  });

export const forgeIssueDeleteComment = (
  repoPath: string,
  number: number,
  commentId: string,
) =>
  invoke<void>("forge_issue_delete_comment", { repoPath, number, commentId });
