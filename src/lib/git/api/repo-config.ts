import { invoke } from "@/lib/tauri/invoke";
import type {
  BranchRequiredRules,
  CheckApp,
  Collaborator,
  GhBranchProtection,
  GhSecret,
  GhVariable,
  Invitation,
  PagesInfo,
  RemoteLens,
  RepoRole,
  RulesetEnforcement,
  RulesetFull,
  RulesetSummary,
  SecretApp,
  SecurityFeature,
  SecurityStatus,
} from "../types";

export const ghSecretsList = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
) => invoke<GhSecret[]>("gh_secrets_list", { repoPath, app, env });

export const ghSecretSet = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
  name: string,
  value: string,
) => invoke<void>("gh_secret_set", { repoPath, app, env, name, value });

export const ghSecretDelete = (
  repoPath: string,
  app: SecretApp,
  env: string | null,
  name: string,
) => invoke<void>("gh_secret_delete", { repoPath, app, env, name });

export const ghVariablesList = (repoPath: string, env: string | null) =>
  invoke<GhVariable[]>("gh_variables_list", { repoPath, env });

export const ghVariableSet = (
  repoPath: string,
  env: string | null,
  name: string,
  value: string,
) => invoke<void>("gh_variable_set", { repoPath, env, name, value });

export const ghVariableDelete = (
  repoPath: string,
  env: string | null,
  name: string,
) => invoke<void>("gh_variable_delete", { repoPath, env, name });

export const ghEnvironmentsList = (repoPath: string) =>
  invoke<string[]>("gh_environments_list", { repoPath });

export const ghCollaboratorsList = (repoPath: string) =>
  invoke<Collaborator[]>("gh_collaborators_list", { repoPath });

/** Returns true when GitHub created a pending invitation, false on an immediate grant. */
export const ghCollaboratorAdd = (
  repoPath: string,
  username: string,
  role: RepoRole,
) => invoke<boolean>("gh_collaborator_add", { repoPath, username, role });

export const ghCollaboratorRemove = (repoPath: string, username: string) =>
  invoke<void>("gh_collaborator_remove", { repoPath, username });

export const ghInvitationsList = (repoPath: string) =>
  invoke<Invitation[]>("gh_invitations_list", { repoPath });

export const ghInvitationUpdate = (
  repoPath: string,
  id: string,
  permission: RepoRole,
) => invoke<void>("gh_invitation_update", { repoPath, id, permission });

export const ghInvitationCancel = (repoPath: string, id: string) =>
  invoke<void>("gh_invitation_cancel", { repoPath, id });

export const ghSecurityGet = (repoPath: string) =>
  invoke<SecurityStatus>("gh_security_get", { repoPath });

export const ghSecurityApply = (
  repoPath: string,
  changes: { feature: SecurityFeature; enabled: boolean }[],
) => invoke<void>("gh_security_apply", { repoPath, changes });

// Lifecycle actions dispatch behind the abstraction — the parameter shapes are
// provider-neutral (GitLab's transfer takes a namespace path as `newOwner`).
export const forgeRepoSetVisibility = (repoPath: string, visibility: string) =>
  invoke<void>("forge_repo_set_visibility", { repoPath, visibility });

export const forgeRepoTransfer = (
  repoPath: string,
  newOwner: string,
  newName: string | null,
) => invoke<void>("forge_repo_transfer", { repoPath, newOwner, newName });

export const forgeRepoDelete = (repoPath: string) =>
  invoke<void>("forge_repo_delete", { repoPath });

export const forgeRepoSetArchived = (repoPath: string, archived: boolean) =>
  invoke<void>("forge_repo_set_archived", { repoPath, archived });

export const forgeRepoRename = (repoPath: string, newName: string) =>
  invoke<void>("forge_repo_rename", { repoPath, newName });

export const ghPagesGet = (repoPath: string) =>
  invoke<PagesInfo | null>("gh_pages_get", { repoPath });

export const ghPagesEnable = (
  repoPath: string,
  buildType: string,
  branch: string | null,
  path: string | null,
) => invoke<void>("gh_pages_enable", { repoPath, buildType, branch, path });

export const ghPagesUpdate = (
  repoPath: string,
  args: {
    buildType?: string;
    branch?: string;
    path?: string;
    cname?: string;
    httpsEnforced?: boolean;
  },
) =>
  invoke<void>("gh_pages_update", {
    repoPath,
    buildType: args.buildType ?? null,
    branch: args.branch ?? null,
    path: args.path ?? null,
    cname: args.cname ?? null,
    httpsEnforced: args.httpsEnforced ?? null,
  });

export const ghPagesDisable = (repoPath: string) =>
  invoke<void>("gh_pages_disable", { repoPath });

export const ghRulesetsList = (repoPath: string) =>
  invoke<RulesetSummary[]>("gh_rulesets_list", { repoPath });

export const ghRulesetGet = (repoPath: string, id: number) =>
  invoke<RulesetFull>("gh_ruleset_get", { repoPath, id });

/** The apps behind the repo's checks, read from the latest check runs on the
 *  default branch's head — GitHub publishes no id→name lookup for an app. Only
 *  apps that have reported there are named. GitHub only. */
export const ghCheckRunApps = (repoPath: string) =>
  invoke<CheckApp[]>("gh_check_run_apps", { repoPath });

/** What a branch's active rules require — check contexts and any approving-review
 *  count. Empty for a readable branch under no rules; a branch this token can't read —
 *  or a name the backend's ref gate refuses — rejects, which a caller showing a
 *  fallback may treat as empty. GitHub only. */
export const ghBranchRequiredChecks = (
  repoPath: string,
  branch: string,
  lens: RemoteLens,
) =>
  invoke<BranchRequiredRules>("gh_branch_required_checks", {
    repoPath,
    branch,
    lens,
  });

export const ghRulesetCreate = (
  repoPath: string,
  body: Record<string, unknown>,
) => invoke<void>("gh_ruleset_create", { repoPath, body });

export const ghRulesetUpdate = (
  repoPath: string,
  id: number,
  body: Record<string, unknown>,
) => invoke<void>("gh_ruleset_update", { repoPath, id, body });

export const ghRulesetDelete = (repoPath: string, id: number) =>
  invoke<void>("gh_ruleset_delete", { repoPath, id });

export const ghRulesetSetEnforcement = (
  repoPath: string,
  id: number,
  enforcement: RulesetEnforcement,
) => invoke<void>("gh_ruleset_set_enforcement", { repoPath, id, enforcement });

/** The repo's local `.github/dependabot.yml` text (null when absent). */
export const dependabotGet = (repoPath: string) =>
  invoke<string | null>("dependabot_get", { repoPath });

export const dependabotSet = (repoPath: string, content: string) =>
  invoke<void>("dependabot_set", { repoPath, content });

export const dependabotDelete = (repoPath: string) =>
  invoke<void>("dependabot_delete", { repoPath });

/** The repo's local `.github/FUNDING.yml` text (null when absent). */
export const fundingGet = (repoPath: string) =>
  invoke<string | null>("funding_get", { repoPath });

export const fundingSet = (repoPath: string, content: string) =>
  invoke<void>("funding_set", { repoPath, content });

export const fundingDelete = (repoPath: string) =>
  invoke<void>("funding_delete", { repoPath });

/** GitHub's (classic) branch protection rules — read-only, for importing. */
export const ghBranchProtections = (repoPath: string) =>
  invoke<GhBranchProtection[]>("gh_branch_protections", { repoPath });
