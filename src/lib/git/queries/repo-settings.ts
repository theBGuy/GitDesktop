import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type {
  BbEnvironment,
  BitbucketHookInput,
  BitbucketRepoSettingsInput,
  GitLabHookInput,
  GitLabProtectedBranch,
  GitLabRepoSettingsInput,
  RepoSettingsInput,
} from "../types";
import { repoSettingsKey, useRepoMutation } from "./internal";

export function useRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: repoSettingsKey(repo),
    queryFn: () => api.ghRepoSettingsGet(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the PATCH, the cache seed below and the invalidation all close over
    // `repo`, and the settings dialog survives a repo switch — without the key a
    // switch seeds the newly-live repo's settings with this repo's response.
    mutationKey: ["update-repo-settings", repo],
    mutationFn: (input: RepoSettingsInput) =>
      api.ghRepoSettingsUpdate(repo, input),
    // The PATCH returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) => queryClient.setQueryData(repoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) }),
  });
}

// The GitLab settings surface — its own query (the models are provider-shaped;
// see GitLabRepoSettings) but the same key family, so lifecycle mutations'
// invalidations hit both providers' reads.
const glRepoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings", "gitlab"] as const;

export function useGlRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glRepoSettingsKey(repo),
    queryFn: () => api.forgeGlRepoSettings(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateGlRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the PUT, the seed below and the invalidation all close over `repo`,
    // and the settings dialog survives a repo switch — without the key a switch
    // seeds the newly-live repo's settings with this repo's response.
    mutationKey: ["update-gl-repo-settings", repo],
    mutationFn: (input: GitLabRepoSettingsInput) =>
      api.forgeGlRepoSettingsUpdate(repo, input),
    // The PUT returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) =>
      queryClient.setQueryData(glRepoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glRepoSettingsKey(repo) }),
  });
}

// The GitLab settings sub-surfaces: Members, Webhooks, CI/CD variables.
const glMembersKey = (repo: string) => ["repo", repo, "gl-members"] as const;

const glHooksKey = (repo: string) => ["repo", repo, "gl-webhooks"] as const;

const glHookEventsKey = (repo: string, hookId: string) =>
  ["repo", repo, "gl-webhook-events", hookId] as const;

const glVariablesKey = (repo: string) =>
  ["repo", repo, "gl-variables"] as const;

export function useGlMembers(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glMembersKey(repo),
    queryFn: () => api.forgeGlMembers(repo),
    enabled,
    retry: false,
  });
}

export function useGlAddMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { username: string; accessLevel: number }) =>
      api.forgeGlMemberAdd(repo, a.username, a.accessLevel),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlUpdateMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { userId: string; accessLevel: number }) =>
      api.forgeGlMemberUpdate(repo, a.userId, a.accessLevel),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlRemoveMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.forgeGlMemberRemove(repo, userId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlHooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glHooksKey(repo),
    queryFn: () => api.forgeGlHooks(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useGlCreateHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the call and the hooks-list invalidation close over `repo`, and the
    // settings dialog survives a repo switch — without the key a switch retargets
    // the pending create.
    mutationKey: ["gl-create-hook", repo],
    mutationFn: (input: GitLabHookInput) => api.forgeGlHookCreate(repo, input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlUpdateHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { hookId: string; input: GitLabHookInput }) =>
      api.forgeGlHookUpdate(repo, a.hookId, a.input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlDeleteHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hookId: string) => api.forgeGlHookDelete(repo, hookId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlTestHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { hookId: string; trigger: string }) =>
      api.forgeGlHookTest(repo, a.hookId, a.trigger),
    // A test lands in the delivery log (and can flip alert_status).
    onSettled: (_d, _e, a) => {
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) });
      queryClient.invalidateQueries({
        queryKey: glHookEventsKey(repo, a.hookId),
      });
    },
  });
}

export function useGlHookEvents(repo: string, hookId: string | null) {
  return useQuery({
    queryKey: glHookEventsKey(repo, hookId ?? ""),
    queryFn: () => api.forgeGlHookEvents(repo, hookId ?? ""),
    enabled: hookId != null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useGlResendHookEvent(repo: string, hookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      api.forgeGlHookResend(repo, hookId, eventId),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glHookEventsKey(repo, hookId),
      }),
  });
}

export function useGlVariables(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glVariablesKey(repo),
    queryFn: () => api.forgeGlVariables(repo),
    enabled,
    retry: false,
  });
}

export function useGlSetVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      key: string;
      value: string;
      protected: boolean;
      masked: boolean;
      create: boolean;
      scope: string;
    }) => api.forgeGlVariableSet(repo, a),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glVariablesKey(repo) }),
  });
}

export function useGlDeleteVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { key: string; scope: string }) =>
      api.forgeGlVariableDelete(repo, a.key, a.scope),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glVariablesKey(repo) }),
  });
}

const glProtectedBranchesKey = (repo: string) =>
  ["repo", repo, "gl-protected-branches"] as const;

export function useGlProtectedBranches(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glProtectedBranchesKey(repo),
    queryFn: () => api.forgeGlProtectedBranches(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useGlProtectBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      name: string;
      pushAccessLevel: number;
      mergeAccessLevel: number;
      allowForcePush: boolean;
    }) => api.forgeGlProtectedBranchCreate(repo, a),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glProtectedBranchesKey(repo),
      }),
  });
}

/** Force-push is the only row-editable field; glab spawns a process per call
 *  (~1s+), so patch the cached row optimistically or the Switch visibly lags
 *  and snaps back. */
export function useGlUpdateProtectedBranch(repo: string) {
  const queryClient = useQueryClient();
  const key = glProtectedBranchesKey(repo);
  return useMutation({
    mutationFn: (a: { name: string; allowForcePush: boolean }) =>
      api.forgeGlProtectedBranchUpdate(repo, a.name, a.allowForcePush),
    onMutate: async (a) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<GitLabProtectedBranch[]>(key);
      queryClient.setQueryData<GitLabProtectedBranch[]>(key, (rows) =>
        rows?.map((r) =>
          r.name === a.name ? { ...r, allowForcePush: a.allowForcePush } : r,
        ),
      );
      return { prev };
    },
    onError: (_e, _a, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useGlUnprotectBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.forgeGlProtectedBranchDelete(repo, name),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glProtectedBranchesKey(repo),
      }),
  });
}

/** Project paths the viewer is a member of on this repo's host — the Move
 *  dialog's destination suggestions (host-correct for self-managed GitLab). */
export function useGlMemberProjects(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "gl-member-projects"] as const,
    queryFn: () => api.forgeGlMemberProjects(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The viewer's publishable GitHub owners — the publish owner picker.
 *  Account-scoped, so NOT repo-keyed; cached broadly like workspaces. */
export function useGhPublishOwners(enabled: boolean) {
  return useQuery({
    queryKey: ["gh", "publish-owners"] as const,
    queryFn: () => api.forgeGhPublishOwners(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ── Bitbucket settings surface ─────────────────────────────────────────────
// Mirrors the useGl* hooks: repo-keyed reads (staleTime + retry:false) and mutations
// that invalidate their read onSettled. The workspaces list is account-scoped, not
// repo-keyed.

/** The viewer's Bitbucket workspaces — the publish target picker. Account-scoped,
 *  so it's NOT repo-keyed; cached broadly since workspaces rarely change. */
export function useBbWorkspaces(enabled: boolean) {
  return useQuery({
    queryKey: ["bb", "workspaces"] as const,
    queryFn: () => api.forgeBbWorkspaces(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const bbRepoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings", "bitbucket"] as const;

export function useBbRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbRepoSettingsKey(repo),
    queryFn: () => api.forgeBbRepoSettings(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbUpdateRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the PUT, the seed below and the invalidation all close over `repo`,
    // and the settings dialog survives a repo switch — without the key a switch
    // seeds the newly-live repo's settings with this repo's response.
    mutationKey: ["bb-update-repo-settings", repo],
    mutationFn: (input: BitbucketRepoSettingsInput) =>
      api.forgeBbRepoSettingsUpdate(repo, input),
    // The PUT returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) =>
      queryClient.setQueryData(bbRepoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: bbRepoSettingsKey(repo) }),
  });
}

const bbDefaultReviewersKey = (repo: string) =>
  ["repo", repo, "bb-default-reviewers"] as const;

export function useBbDefaultReviewers(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbDefaultReviewersKey(repo),
    queryFn: () => api.forgeBbDefaultReviewers(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Workspace members (no author exclusion) — the default-reviewers picker. */
export function useBbMemberCandidates(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "bb-member-candidates"] as const,
    queryFn: () => api.forgeBbMemberCandidates(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useBbAddDefaultReviewer(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbDefaultReviewerAdd(repo, uuid),
    {
      invalidate: [bbDefaultReviewersKey(repo)],
    },
  );
}

export function useBbRemoveDefaultReviewer(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbDefaultReviewerRemove(repo, uuid),
    {
      invalidate: [bbDefaultReviewersKey(repo)],
    },
  );
}

const bbBranchRestrictionsKey = (repo: string) =>
  ["repo", repo, "bb-branch-restrictions"] as const;

export function useBbBranchRestrictions(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbBranchRestrictionsKey(repo),
    queryFn: () => api.forgeBbBranchRestrictions(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbCreateBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (a: { kind: string; pattern: string; value: number | null }) =>
      api.forgeBbBranchRestrictionCreate(repo, a.kind, a.pattern, a.value),
    {
      invalidate: [bbBranchRestrictionsKey(repo)],
      // Pinned: the call and the narrowed invalidation close over `repo`, and the
      // settings dialog survives a repo switch — without the key a switch retargets
      // the pending create.
      identity: ["bb-create-branch-restriction", repo],
    },
  );
}

export function useBbUpdateBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (a: { id: string; kind: string; pattern: string; value: number | null }) =>
      api.forgeBbBranchRestrictionUpdate(
        repo,
        a.id,
        a.kind,
        a.pattern,
        a.value,
      ),
    { invalidate: [bbBranchRestrictionsKey(repo)] },
  );
}

export function useBbDeleteBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (id: string) => api.forgeBbBranchRestrictionDelete(repo, id),
    { invalidate: [bbBranchRestrictionsKey(repo)] },
  );
}

const bbPipelinesConfigKey = (repo: string) =>
  ["repo", repo, "bb-pipelines-config"] as const;

export function useBbPipelinesConfig(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbPipelinesConfigKey(repo),
    queryFn: () => api.forgeBbPipelinesConfig(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbSetPipelinesEnabled(repo: string) {
  return useRepoMutation(
    repo,
    (enabled: boolean) => api.forgeBbPipelinesConfigUpdate(repo, enabled),
    { invalidate: [bbPipelinesConfigKey(repo)] },
  );
}

export const bbVariablesKey = (repo: string) =>
  ["repo", repo, "bb-variables"] as const;

export function useBbVariables(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbVariablesKey(repo),
    queryFn: () => api.forgeBbPipelineVariables(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// Create/update do NOT invalidate immediately: Bitbucket's variables LIST lags a
// write by ~1s (server replication), so an immediate refetch returns a list WITHOUT
// the just-written row and clobbers the optimistic cache patch (the row blinks out).
// The caller upserts the row into the cache and schedules ONE delayed invalidate to
// reconcile the real server row/uuid. Delete keeps its immediate invalidate below.
export function useBbCreateVariable(repo: string) {
  return useMutation({
    // Pinned: the call closes over `repo` and the variables section survives a repo
    // switch — without the key a switch retargets the pending create, writing the
    // variable to the newly-live repo.
    mutationKey: ["bb-create-variable", repo],
    mutationFn: (a: { key: string; value: string; secured: boolean }) =>
      api.forgeBbPipelineVariableCreate(repo, a.key, a.value, a.secured),
  });
}

export function useBbUpdateVariable(repo: string) {
  return useMutation({
    mutationFn: (a: { uuid: string; value: string; secured: boolean }) =>
      api.forgeBbPipelineVariableUpdate(repo, a.uuid, a.value, a.secured),
  });
}

export function useBbDeleteVariable(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbPipelineVariableDelete(repo, uuid),
    { invalidate: [bbVariablesKey(repo)] },
  );
}

const bbSchedulesKey = (repo: string) =>
  ["repo", repo, "bb-schedules"] as const;

export function useBbSchedules(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbSchedulesKey(repo),
    queryFn: () => api.forgeBbPipelineSchedules(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// Create does NOT invalidate immediately — same ~1s Bitbucket list-replication lag as
// pipeline variables (see useBbCreateVariable): the refetch would return a list WITHOUT
// the new row. The caller upserts the row and schedules ONE delayed invalidate.
// Toggle/delete keep their immediate invalidate below.
export function useBbCreateSchedule(repo: string) {
  return useMutation({
    // Pinned: the call closes over `repo` and the schedules section survives a repo
    // switch — without the key a switch retargets the pending create, scheduling
    // against the newly-live repo.
    mutationKey: ["bb-create-schedule", repo],
    mutationFn: (a: {
      refName: string;
      cronPattern: string;
      enabled: boolean;
    }) =>
      api.forgeBbPipelineScheduleCreate(
        repo,
        a.refName,
        a.cronPattern,
        a.enabled,
      ),
  });
}

export function useBbSetScheduleEnabled(repo: string) {
  return useRepoMutation(
    repo,
    (a: { uuid: string; enabled: boolean }) =>
      api.forgeBbPipelineScheduleSetEnabled(repo, a.uuid, a.enabled),
    { invalidate: [bbSchedulesKey(repo)] },
  );
}

export function useBbDeleteSchedule(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbPipelineScheduleDelete(repo, uuid),
    { invalidate: [bbSchedulesKey(repo)] },
  );
}

const bbHooksKey = (repo: string) => ["repo", repo, "bb-webhooks"] as const;

export function useBbHooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbHooksKey(repo),
    queryFn: () => api.forgeBbHooks(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbCreateHook(repo: string) {
  return useRepoMutation(
    repo,
    (input: BitbucketHookInput) => api.forgeBbHookCreate(repo, input),
    {
      invalidate: [bbHooksKey(repo)],
      // Pinned: the call and the narrowed invalidation close over `repo`, and the
      // settings dialog survives a repo switch — without the key a switch retargets
      // the pending create.
      identity: ["bb-create-hook", repo],
    },
  );
}

export function useBbUpdateHook(repo: string) {
  return useRepoMutation(
    repo,
    (a: { uuid: string; input: BitbucketHookInput }) =>
      api.forgeBbHookUpdate(repo, a.uuid, a.input),
    { invalidate: [bbHooksKey(repo)] },
  );
}

export function useBbDeleteHook(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbHookDelete(repo, uuid),
    { invalidate: [bbHooksKey(repo)] },
  );
}

/** The repo's Bitbucket deployment environments (rank-sorted). Read-only —
 *  fetched only when the consuming surface is enabled. */
export function useBbEnvironments(repo: string, enabled: boolean) {
  return useQuery<BbEnvironment[]>({
    queryKey: ["repo", repo, "bb-environments"] as const,
    queryFn: () => api.forgeBbEnvironments(repo),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
