import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { PROVIDERS_REQUIRING_KEY } from "@/lib/ai/providers";
import type { AiProviderId } from "@/lib/ai/types";
import { getSecret } from "@/lib/git/api";
import { repoIdentity } from "@/lib/git/repo-identity";
import {
  commitAppearance,
  sanitizeAccentHue,
  sanitizeUiFont,
  type ThemeSetting,
  type UiFont,
} from "@/lib/theme";
import {
  type AppSettings,
  addRecentRepo,
  loadSettings,
  persistRepoOwners,
  relocateRecentRepo,
  removeRecentRepo,
  saveSettingsMerged,
  setRepoAlias,
} from "./api";
import type { RepoKeys } from "./mcp";

export const settingsKeys = {
  settings: ["settings"] as const,
  secret: (provider: AiProviderId) => ["secret-present", provider] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.settings,
    queryFn: loadSettings,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The scope/override lookup keys for a repo, most-preferred LAST: `[repoPath]`
 * while the identity is still resolving (or when null — no repo open → `[]`), and
 * `[repoPath, identity]` (deduped) once `repoIdentity` resolves. Feeds the MCP
 * scope helpers ({@link isServerAvailable} et al.) so a repo-scoped server or
 * per-repo override set from one checkout matches from a sibling worktree, while
 * a value still under a raw checkout path (pre-identity-keying) keeps matching.
 *
 * Identity is stable for a session, so this never refetches (`staleTime`
 * Infinity) — a plain query, safe to read inside an `<Activity>`-managed tab
 * (no effects).
 */
export function useRepoKeys(repoPath: string | null): RepoKeys {
  const { data: identity } = useQuery({
    queryKey: ["repo-identity", repoPath],
    queryFn: () => repoIdentity(repoPath as string),
    enabled: !!repoPath,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // Stable reference across renders (same repoPath/identity) so it can sit in
  // downstream `useMemo` dependency arrays without churning them.
  return useMemo(() => {
    if (!repoPath) return [];
    return identity && identity !== repoPath
      ? [repoPath, identity]
      : [repoPath];
  }, [repoPath, identity]);
}

/** Whether AI features are shown. False once the user hides them in Settings;
 *  defaults to true while settings load (AI shown unless explicitly hidden). */
export function useAiEnabled(): boolean {
  const settings = useSettings();
  return !settings.data?.hideAi;
}

/** Whether a link preview may contact the linked site. Reads false until the
 *  store answers — the opposite of {@link useAiEnabled}'s optimism, because
 *  guessing wrong here would reach a third-party host the user opted out of;
 *  the query resolves once per session and the card re-renders with the real
 *  value. */
export function useFetchLinkPreviews(): boolean {
  const settings = useSettings();
  return settings.data?.fetchLinkPreviews ?? false;
}

/**
 * Whether the commit/PR generation provider is actually usable: a saved API
 * key for key-based providers (Anthropic/OpenAI/OpenRouter), always true for
 * local ones (Ollama). Optimistic while the keychain read is in flight, so the
 * "Set up AI" prompt only appears once we've confirmed there's no key — it
 * never flashes for an already-configured user.
 */
export function useAiConfigured(): boolean {
  const settings = useSettings();
  const provider = settings.data?.ai.provider ?? "anthropic";
  const needsKey = PROVIDERS_REQUIRING_KEY.includes(provider);
  const secret = useSecretPreview(provider);
  if (!needsKey) return true;
  return secret.isSuccess ? secret.data !== null : true;
}

/**
 * Whether the **review** model (Settings → AI → Review model) is usable: a saved
 * key for key-based providers, always true for local/CLI ones. Mirrors
 * {@link useAiConfigured} but for `reviewAi` — used to gate AI conflict resolution
 * and the Debug-with-AI affordances.
 */
export function useReviewConfigured(): boolean {
  const settings = useSettings();
  const provider = settings.data?.reviewAi.provider ?? "anthropic";
  const needsKey = PROVIDERS_REQUIRING_KEY.includes(provider);
  const secret = useSecretPreview(provider);
  if (!needsKey) return true;
  return secret.isSuccess ? secret.data !== null : true;
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: AppSettings) => saveSettingsMerged(settings),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

/**
 * Apply an appearance change from any entry point — the Appearance pickers
 * and the `cycle-theme` command all go through this, so the paths can't drift.
 * It optimistically patches the settings cache (so a bound `<Select>` or
 * slider reflects the choice immediately), persists it, applies the DOM, and
 * rolls back if the store write throws. `useSaveSettings`'s success-invalidate
 * reconciles the cache on the happy path.
 */
export type AppearancePatch = {
  theme?: ThemeSetting;
  accentHue?: number;
  uiFont?: UiFont;
};

export function useApplyAppearance() {
  const queryClient = useQueryClient();
  const saveSettings = useSaveSettings();

  return useCallback(
    (current: AppSettings, patch: AppearancePatch) => {
      // Merge onto the cache, not the caller's snapshot: a hue drag writes the
      // cache on every tick, and a theme/font persist in the same gesture must
      // keep that hue rather than the pre-drag snapshot.
      const base =
        queryClient.getQueryData<AppSettings>(settingsKeys.settings) ?? current;
      const updated: AppSettings = {
        ...base,
        ...patch,
        accentHue:
          patch.accentHue !== undefined
            ? sanitizeAccentHue(patch.accentHue)
            : base.accentHue,
        uiFont:
          patch.uiFont !== undefined
            ? sanitizeUiFont(patch.uiFont)
            : base.uiFont,
      };
      if (
        updated.theme === base.theme &&
        updated.accentHue === base.accentHue &&
        updated.uiFont === base.uiFont
      ) {
        return;
      }
      queryClient.setQueryData(settingsKeys.settings, updated);
      commitAppearance(updated);
      saveSettings.mutate(updated, {
        onError: () => {
          // Only roll back if this call's change is still the latest: otherwise a
          // late-failing earlier write would stomp a newer successful one.
          const latest = queryClient.getQueryData<AppSettings>(
            settingsKeys.settings,
          );
          if (
            latest?.theme !== updated.theme ||
            latest?.accentHue !== updated.accentHue ||
            latest?.uiFont !== updated.uiFont
          ) {
            return;
          }
          queryClient.setQueryData(settingsKeys.settings, base);
          commitAppearance(base);
        },
      });
    },
    [queryClient, saveSettings],
  );
}

/** Theme-only wrapper so Cycle-theme and the theme picker stay one-liners. */
export function useApplyTheme() {
  const apply = useApplyAppearance();
  return useCallback(
    (current: AppSettings, next: ThemeSetting) => {
      apply(current, { theme: next });
    },
    [apply],
  );
}

export function useAddRecentRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repo: { path: string; name: string }) => addRecentRepo(repo),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

/** Backfills resolved owners + hosts onto the recent-repo records (see
 *  `persistRepoOwners`) so the repo list groups synchronously next open. */
export function usePersistRepoOwners() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      owners: {
        path: string;
        owner: string | null;
        host: string | null;
        provider: string | null;
      }[],
    ) => persistRepoOwners(owners),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

export function useSetRepoAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; alias: string }) =>
      setRepoAlias(args.path, args.alias),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

export function useRemoveRecentRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => removeRecentRepo(path),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

/** Repoints a recent-repo row to a moved folder's new path (see
 *  `relocateRecentRepo`). */
export function useRelocateRecentRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { oldPath: string; newPath: string }) =>
      relocateRecentRepo(args.oldPath, args.newPath),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),
  });
}

/** The display alias for a repo path, when one is set. */
export function useRepoAlias(path: string | null): string | undefined {
  const settings = useSettings();
  return settings.data?.recentRepos.find((r) => r.path === path)?.alias;
}

export interface SecretPreview {
  length: number;
  /** e.g. "sk-pro…f3Kd" — enough to recognize a key without exposing it. */
  masked: string;
}

export function useSecretPreview(provider: AiProviderId) {
  return useQuery({
    queryKey: settingsKeys.secret(provider),
    queryFn: async (): Promise<SecretPreview | null> => {
      const value = await getSecret(provider);
      if (!value) return null;
      const prefix = value.slice(0, Math.min(6, value.length));
      const suffix = value.length > 12 ? value.slice(-4) : "";
      return { length: value.length, masked: `${prefix}…${suffix}` };
    },
  });
}
