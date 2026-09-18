import { invoke } from "@/lib/tauri/invoke";
import type {
  BbEnvironment,
  BitbucketBranchRestriction,
  BitbucketPipelineSchedule,
  BitbucketPipelinesConfig,
  BitbucketPipelineVariable,
  BitbucketRepoSettings,
  BitbucketRepoSettingsInput,
  BitbucketWorkspace,
  ForgeUserRef,
  GitLabMember,
  GitLabProtectedBranch,
  GitLabRepoSettings,
  GitLabRepoSettingsInput,
  GitLabVariable,
  RepoSettings,
  RepoSettingsInput,
} from "../types";

/** The GitLab project-settings read (GitLab repos only — GitHub stays on
 *  `ghRepoSettingsGet`; the models are provider-shaped). */
export const forgeGlRepoSettings = (repoPath: string) =>
  invoke<GitLabRepoSettings>("forge_gl_repo_settings", { repoPath });

/** Batch-save the GitLab project settings; returns the updated read. */
export const forgeGlRepoSettingsUpdate = (
  repoPath: string,
  input: GitLabRepoSettingsInput,
) =>
  invoke<GitLabRepoSettings>("forge_gl_repo_settings_update", {
    repoPath,
    input,
  });

// The GitLab settings sub-surfaces (Members / CI/CD variables; webhook CRUD
// lives in webhooks.ts) — GitLab repos only; the GitHub dialog keeps its
// gh-backed sections.
export const forgeGlMembers = (repoPath: string) =>
  invoke<GitLabMember[]>("forge_gl_members", { repoPath });

export const forgeGlMemberAdd = (
  repoPath: string,
  username: string,
  accessLevel: number,
) => invoke<void>("forge_gl_member_add", { repoPath, username, accessLevel });

export const forgeGlMemberUpdate = (
  repoPath: string,
  userId: string,
  accessLevel: number,
) => invoke<void>("forge_gl_member_update", { repoPath, userId, accessLevel });

export const forgeGlMemberRemove = (repoPath: string, userId: string) =>
  invoke<void>("forge_gl_member_remove", { repoPath, userId });

export const forgeGlVariables = (repoPath: string) =>
  invoke<GitLabVariable[]>("forge_gl_variables", { repoPath });

export const forgeGlVariableSet = (
  repoPath: string,
  args: {
    key: string;
    value: string;
    protected: boolean;
    masked: boolean;
    create: boolean;
    /** The scope the write addresses ("*" for unscoped; creates always "*"). */
    scope: string;
  },
) => invoke<void>("forge_gl_variable_set", { repoPath, ...args });

export const forgeGlVariableDelete = (
  repoPath: string,
  key: string,
  scope: string,
) => invoke<void>("forge_gl_variable_delete", { repoPath, key, scope });

export const forgeGlProtectedBranches = (repoPath: string) =>
  invoke<GitLabProtectedBranch[]>("forge_gl_protected_branches", { repoPath });

export const forgeGlProtectedBranchCreate = (
  repoPath: string,
  args: {
    name: string;
    pushAccessLevel: number;
    mergeAccessLevel: number;
    allowForcePush: boolean;
  },
) => invoke<void>("forge_gl_protected_branch_create", { repoPath, ...args });

export const forgeGlProtectedBranchUpdate = (
  repoPath: string,
  name: string,
  allowForcePush: boolean,
) =>
  invoke<void>("forge_gl_protected_branch_update", {
    repoPath,
    name,
    allowForcePush,
  });

export const forgeGlProtectedBranchDelete = (repoPath: string, name: string) =>
  invoke<void>("forge_gl_protected_branch_delete", { repoPath, name });

/** Project paths the viewer is a member of on THIS repo's host — the Move
 *  dialog's suggestions (host-correct for self-managed GitLab). */
export const forgeGlMemberProjects = (repoPath: string) =>
  invoke<string[]>("forge_gl_member_projects", { repoPath });

// ── Bitbucket settings surface — Bitbucket repos only; the GitHub / GitLab dialogs
//    keep their own provider-shaped sections.

/** The viewer's Bitbucket workspaces — the publish target picker (account-scoped). */
export const forgeBbWorkspaces = () =>
  invoke<BitbucketWorkspace[]>("forge_bb_workspaces");

export const forgeBbRepoSettings = (repoPath: string) =>
  invoke<BitbucketRepoSettings>("forge_bb_repo_settings", { repoPath });

export const forgeBbRepoSettingsUpdate = (
  repoPath: string,
  input: BitbucketRepoSettingsInput,
) =>
  invoke<BitbucketRepoSettings>("forge_bb_repo_settings_update", {
    repoPath,
    input,
  });

export const forgeBbDefaultReviewers = (repoPath: string) =>
  invoke<ForgeUserRef[]>("forge_bb_default_reviewers", { repoPath });

export const forgeBbDefaultReviewerAdd = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_default_reviewer_add", { repoPath, uuid });

export const forgeBbDefaultReviewerRemove = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_default_reviewer_remove", { repoPath, uuid });

/** Workspace members WITHOUT the author exclusion — the default-reviewers picker. */
export const forgeBbMemberCandidates = (repoPath: string) =>
  invoke<ForgeUserRef[]>("forge_bb_member_candidates", { repoPath });

export const forgeBbBranchRestrictions = (repoPath: string) =>
  invoke<BitbucketBranchRestriction[]>("forge_bb_branch_restrictions", {
    repoPath,
  });

export const forgeBbBranchRestrictionCreate = (
  repoPath: string,
  kind: string,
  pattern: string,
  value: number | null,
) =>
  invoke<void>("forge_bb_branch_restriction_create", {
    repoPath,
    kind,
    pattern,
    value,
  });

export const forgeBbBranchRestrictionUpdate = (
  repoPath: string,
  id: string,
  kind: string,
  pattern: string,
  value: number | null,
) =>
  invoke<void>("forge_bb_branch_restriction_update", {
    repoPath,
    id,
    kind,
    pattern,
    value,
  });

export const forgeBbBranchRestrictionDelete = (repoPath: string, id: string) =>
  invoke<void>("forge_bb_branch_restriction_delete", { repoPath, id });

export const forgeBbPipelinesConfig = (repoPath: string) =>
  invoke<BitbucketPipelinesConfig>("forge_bb_pipelines_config", { repoPath });

export const forgeBbPipelinesConfigUpdate = (
  repoPath: string,
  enabled: boolean,
) => invoke<void>("forge_bb_pipelines_config_update", { repoPath, enabled });

export const forgeBbPipelineVariables = (repoPath: string) =>
  invoke<BitbucketPipelineVariable[]>("forge_bb_pipeline_variables", {
    repoPath,
  });

export const forgeBbPipelineVariableCreate = (
  repoPath: string,
  key: string,
  value: string,
  secured: boolean,
) =>
  invoke<void>("forge_bb_pipeline_variable_create", {
    repoPath,
    key,
    value,
    secured,
  });

export const forgeBbPipelineVariableUpdate = (
  repoPath: string,
  uuid: string,
  value: string,
  secured: boolean,
) =>
  invoke<void>("forge_bb_pipeline_variable_update", {
    repoPath,
    uuid,
    value,
    secured,
  });

export const forgeBbPipelineVariableDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_pipeline_variable_delete", { repoPath, uuid });

export const forgeBbPipelineSchedules = (repoPath: string) =>
  invoke<BitbucketPipelineSchedule[]>("forge_bb_pipeline_schedules", {
    repoPath,
  });

export const forgeBbPipelineScheduleCreate = (
  repoPath: string,
  refName: string,
  cronPattern: string,
  enabled: boolean,
) =>
  invoke<void>("forge_bb_pipeline_schedule_create", {
    repoPath,
    refName,
    cronPattern,
    enabled,
  });

export const forgeBbPipelineScheduleSetEnabled = (
  repoPath: string,
  uuid: string,
  enabled: boolean,
) =>
  invoke<void>("forge_bb_pipeline_schedule_set_enabled", {
    repoPath,
    uuid,
    enabled,
  });

export const forgeBbPipelineScheduleDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_pipeline_schedule_delete", { repoPath, uuid });

/** The repo's deployment environments, sorted by rank ascending (Bitbucket-only). */
export const forgeBbEnvironments = (repoPath: string) =>
  invoke<BbEnvironment[]>("forge_bb_environments", { repoPath });

// ── GitHub repo settings ─────────────────────────────────────────────────────

export const ghRepoSettingsGet = (repoPath: string) =>
  invoke<RepoSettings>("gh_repo_settings_get", { repoPath });

export const ghRepoSettingsUpdate = (
  repoPath: string,
  input: RepoSettingsInput,
) => invoke<RepoSettings>("gh_repo_settings_update", { repoPath, input });
