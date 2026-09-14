import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import { invoke } from "@/lib/tauri/invoke";
import {
  addTask,
  loadScripts,
  removeTask,
  setTasksEnabled,
  updateTask,
} from "./store";
import type { ResolvedTaskScript, TaskDef } from "./types";

export const scriptsKeys = {
  config: ["scripts"] as const,
};

/** The task config (enable flag + task list). Personal app-data, session-stable —
 *  a plain query (staleTime Infinity), safe to read inside an `<Activity>` tab.
 *  Local read: the default "online" mode parks it while the OS reports no
 *  connection, which would leave every task surface empty. */
export function useScripts() {
  return useQuery({
    queryKey: scriptsKeys.config,
    queryFn: loadScripts,
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });
}

/**
 * The scope lookup keys for a repo, most-preferred LAST: `[repoPath]` while the
 * identity is still resolving (or when it IS the path), `[repoPath, identity]`
 * once they differ, and `[]` when no repo is open. `settled` reports that the
 * lookup is done, so a caller can hold scope classification until then rather
 * than flashing an identity-scoped task through "other repos" — a lookup that
 * FAILED settles too, on `[repoPath]`, until a remount refetches the identity.
 *
 * Shares the `["repo-identity", repoPath]` query with settings' `useRepoKeys`, so
 * one identity lookup serves both registries. A plain query (the shared identity
 * options), safe to read inside an `<Activity>`-managed tab — no effects.
 */
export function useTaskRepoKeys(repoPath: string | null): {
  keys: readonly string[];
  settled: boolean;
} {
  const { data: identity, isFetched } = useQuery(
    repoIdentityQueryOptions(repoPath),
  );
  // Stable reference across renders (same repoPath/identity) so it can sit in
  // downstream `useMemo` dependency arrays without churning them.
  return useMemo(() => {
    if (!repoPath) return { keys: [], settled: true };
    const keys =
      identity && identity !== repoPath ? [repoPath, identity] : [repoPath];
    return { keys, settled: isFetched };
  }, [repoPath, identity, isFetched]);
}

/** Where a file task's script resolves in this repo, and whether it's there: a
 *  repo-relative task path names a different file in every repo, so the run
 *  surfaces show the resolved target before starting. Inline tasks have nothing
 *  to resolve (query disabled). Short staleTime — the file can appear or vanish
 *  between runs; `networkMode` always because this is a local disk read the
 *  default online mode would park while the OS reports no connection. */
export function useResolvedTaskScript(
  task: TaskDef | null,
  repoPath: string | null,
) {
  const path = task?.source.kind === "file" ? task.source.path : null;
  return useQuery({
    queryKey: ["resolve-task-script", repoPath, path],
    queryFn: () =>
      invoke<ResolvedTaskScript>("resolve_task_script", {
        cwd: repoPath,
        path,
      }),
    enabled: path !== null && !!repoPath,
    staleTime: 30_000,
    networkMode: "always",
  });
}

function useScriptsMutation<A>(fn: (arg: A) => Promise<void>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // Local write — see useScripts: "online" mode would park it offline, so a
    // first-run confirmation or an edit would sit unwritten until the app closed.
    networkMode: "always",
    onSuccess: () => qc.invalidateQueries({ queryKey: scriptsKeys.config }),
  });
}

export const useSetTasksEnabled = () => useScriptsMutation(setTasksEnabled);
export const useAddTask = () => useScriptsMutation(addTask);
export const useUpdateTask = () => useScriptsMutation(updateTask);
export const useRemoveTask = () => useScriptsMutation(removeTask);
