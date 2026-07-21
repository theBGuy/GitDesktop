import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addTask,
  loadScripts,
  removeTask,
  setTasksEnabled,
  updateTask,
} from "./store";

export const scriptsKeys = {
  config: ["scripts"] as const,
};

/** The task config (enable flag + task list). Personal app-data, session-stable —
 *  a plain query (staleTime Infinity), safe to read inside an `<Activity>` tab. */
export function useScripts() {
  return useQuery({
    queryKey: scriptsKeys.config,
    queryFn: loadScripts,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

function useScriptsMutation<A>(fn: (arg: A) => Promise<void>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: scriptsKeys.config }),
  });
}

export const useSetTasksEnabled = () => useScriptsMutation(setTasksEnabled);
export const useAddTask = () => useScriptsMutation(addTask);
export const useUpdateTask = () => useScriptsMutation(updateTask);
export const useRemoveTask = () => useScriptsMutation(removeTask);
