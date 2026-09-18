import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type {
  RepoRole,
  RulesetEnforcement,
  SecretApp,
  SecurityFeature,
} from "../types";
import { repoSettingsKey } from "./internal";

// Secrets & variables. `env: null` = repository scope; a string = that
// environment (Actions only). Keyed by app + scope so each list caches apart.
const secretsKey = (repo: string, app: SecretApp, env: string | null) =>
  ["repo", repo, "secrets", app, env ?? "$repo"] as const;

const variablesKey = (repo: string, env: string | null) =>
  ["repo", repo, "variables", env ?? "$repo"] as const;

export function useSecrets(
  repo: string,
  app: SecretApp,
  env: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: secretsKey(repo, app, env),
    queryFn: () => api.ghSecretsList(repo, app, env),
    enabled,
    retry: false,
  });
}

export function useSetSecret(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      app: SecretApp;
      env: string | null;
      name: string;
      value: string;
    }) => api.ghSecretSet(repo, a.app, a.env, a.name, a.value),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({
        queryKey: secretsKey(repo, a.app, a.env),
      }),
  });
}

export function useDeleteSecret(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { app: SecretApp; env: string | null; name: string }) =>
      api.ghSecretDelete(repo, a.app, a.env, a.name),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({
        queryKey: secretsKey(repo, a.app, a.env),
      }),
  });
}

export function useVariables(
  repo: string,
  env: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: variablesKey(repo, env),
    queryFn: () => api.ghVariablesList(repo, env),
    enabled,
    retry: false,
  });
}

export function useSetVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { env: string | null; name: string; value: string }) =>
      api.ghVariableSet(repo, a.env, a.name, a.value),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({ queryKey: variablesKey(repo, a.env) }),
  });
}

export function useDeleteVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { env: string | null; name: string }) =>
      api.ghVariableDelete(repo, a.env, a.name),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({ queryKey: variablesKey(repo, a.env) }),
  });
}

export function useEnvironments(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "environments"] as const,
    queryFn: () => api.ghEnvironmentsList(repo),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

const dependabotKey = (repo: string) => ["repo", repo, "dependabot"] as const;

/** The repo's local `.github/dependabot.yml` text (null when there is none). */
export function useDependabotConfig(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: dependabotKey(repo),
    queryFn: () => api.dependabotGet(repo),
    enabled,
    retry: false,
  });
}

export function useSetDependabot(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.dependabotSet(repo, content),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: dependabotKey(repo) }),
  });
}

export function useDeleteDependabot(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.dependabotDelete(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: dependabotKey(repo) }),
  });
}

const fundingKey = (repo: string) => ["repo", repo, "funding"] as const;

/** The repo's local `.github/FUNDING.yml` text (null when there is none). */
export function useFunding(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: fundingKey(repo),
    queryFn: () => api.fundingGet(repo),
    enabled,
    retry: false,
  });
}

export function useSetFunding(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.fundingSet(repo, content),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: fundingKey(repo) }),
  });
}

export function useDeleteFunding(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.fundingDelete(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: fundingKey(repo) }),
  });
}

const collaboratorsKey = (repo: string) =>
  ["repo", repo, "collaborators"] as const;

const invitationsKey = (repo: string) => ["repo", repo, "invitations"] as const;

export function useCollaborators(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: collaboratorsKey(repo),
    queryFn: () => api.ghCollaboratorsList(repo),
    enabled,
    retry: false,
  });
}

export function useAddCollaborator(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { username: string; role: RepoRole }) =>
      api.ghCollaboratorAdd(repo, a.username, a.role),
    // An add can land as an immediate grant OR a pending invitation.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: collaboratorsKey(repo) });
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) });
    },
  });
}

export function useRemoveCollaborator(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.ghCollaboratorRemove(repo, username),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: collaboratorsKey(repo) }),
  });
}

export function useInvitations(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: invitationsKey(repo),
    queryFn: () => api.ghInvitationsList(repo),
    enabled,
    retry: false,
  });
}

export function useUpdateInvitation(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; permission: RepoRole }) =>
      api.ghInvitationUpdate(repo, a.id, a.permission),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) }),
  });
}

export function useCancelInvitation(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.ghInvitationCancel(repo, id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) }),
  });
}

const securityKey = (repo: string) => ["repo", repo, "security"] as const;

export function useSecurity(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: securityKey(repo),
    queryFn: () => api.ghSecurityGet(repo),
    enabled,
    retry: false,
  });
}

export function useApplySecurity(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: { feature: SecurityFeature; enabled: boolean }[]) =>
      api.ghSecurityApply(repo, changes),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: securityKey(repo) }),
  });
}

// Lifecycle mutations dispatch behind the abstraction (GitHub repo / GitLab
// project). `repoSettingsKey` invalidation prefix-matches the GitLab settings
// key too, so both providers' reads refresh.
export function useSetVisibility(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibility: string) =>
      api.forgeRepoSetVisibility(repo, visibility),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) });
      queryClient.invalidateQueries({ queryKey: securityKey(repo) });
    },
  });
}

export function useTransferRepo(repo: string) {
  return useMutation({
    mutationFn: (a: { newOwner: string; newName: string | null }) =>
      api.forgeRepoTransfer(repo, a.newOwner, a.newName),
  });
}

export function useDeleteRepo(repo: string) {
  return useMutation({ mutationFn: () => api.forgeRepoDelete(repo) });
}

export function useSetArchived(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) => api.forgeRepoSetArchived(repo, archived),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) }),
  });
}

export function useRenameRepo(repo: string) {
  return useMutation({
    mutationFn: (newName: string) => api.forgeRepoRename(repo, newName),
  });
}

const pagesKey = (repo: string) => ["repo", repo, "pages"] as const;

/** GitHub Pages config (null when Pages is disabled). */
export function usePages(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: pagesKey(repo),
    queryFn: () => api.ghPagesGet(repo),
    enabled,
    retry: false,
  });
}

export function useEnablePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      buildType: string;
      branch: string | null;
      path: string | null;
    }) => api.ghPagesEnable(repo, a.buildType, a.branch, a.path),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

export function useUpdatePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      buildType?: string;
      branch?: string;
      path?: string;
      cname?: string;
      httpsEnforced?: boolean;
    }) => api.ghPagesUpdate(repo, args),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

export function useDisablePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.ghPagesDisable(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

const rulesetsKey = (repo: string) => ["repo", repo, "rulesets"] as const;

const rulesetKey = (repo: string, id: number | null) =>
  ["repo", repo, "ruleset", id] as const;

const checkRunAppsKey = (repo: string) =>
  ["repo", repo, "check-run-apps"] as const;

export function useRulesets(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: rulesetsKey(repo),
    queryFn: () => api.ghRulesetsList(repo),
    enabled,
    retry: false,
  });
}

/** The full ruleset for the editor; only fetches once an id is set. */
export function useRuleset(repo: string, id: number | null) {
  return useQuery({
    queryKey: rulesetKey(repo, id),
    queryFn: () => api.ghRulesetGet(repo, id as number),
    enabled: id != null,
    retry: false,
  });
}

/** The apps behind the repo's checks, for naming a required-check pin. Advisory:
 *  a failure leaves the pins showing their raw ids, so it never retries, and the
 *  set changes about as often as the repo's CI does. */
export function useCheckRunApps(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: checkRunAppsKey(repo),
    queryFn: () => api.ghCheckRunApps(repo),
    staleTime: 10 * 60_000,
    enabled,
    retry: false,
  });
}

export function useCreateRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the call and the rulesets invalidation close over `repo`, and the
    // settings dialog survives a repo switch — without the key a switch retargets the
    // pending create.
    mutationKey: ["create-ruleset", repo],
    mutationFn: (body: Record<string, unknown>) =>
      api.ghRulesetCreate(repo, body),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}

export function useUpdateRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: number; body: Record<string, unknown> }) =>
      api.ghRulesetUpdate(repo, a.id, a.body),
    onSettled: (_d, _e, a) => {
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) });
      queryClient.invalidateQueries({ queryKey: rulesetKey(repo, a.id) });
    },
  });
}

export function useDeleteRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.ghRulesetDelete(repo, id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}

export function useSetRulesetEnforcement(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: number; enforcement: RulesetEnforcement }) =>
      api.ghRulesetSetEnforcement(repo, a.id, a.enforcement),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}
