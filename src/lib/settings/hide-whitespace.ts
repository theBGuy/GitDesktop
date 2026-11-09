import { useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast";
import type { AppSettings } from "./api";
import { settingsKeys, useSaveSettingsPatch, useSettings } from "./queries";

/** Bumped by every flip, so a late rejection of an older write never rolls
 *  back a newer one. */
let flipSeq = 0;

/** The persisted, app-wide "Hide whitespace changes" choice; off until the
 *  settings have loaded. */
export function useHideWhitespace(): boolean {
  return useSettings().data?.diffHideWhitespace === true;
}

/** Flips the choice. The settings cache is patched first, so the gear and
 *  every diff read re-key in the same commit, then only the field is written. */
export function useSetHideWhitespace(): (next: boolean) => void {
  const queryClient = useQueryClient();
  const save = useSaveSettingsPatch();
  return (next: boolean) => {
    const current = queryClient.getQueryData<AppSettings>(
      settingsKeys.settings,
    );
    if (current === undefined) return;
    const previous = current.diffHideWhitespace === true;
    if (previous === next) return;
    const seq = ++flipSeq;
    // A settings read already running would land the old value over the patch.
    void queryClient.cancelQueries({
      queryKey: settingsKeys.settings,
      exact: true,
    });
    queryClient.setQueryData(settingsKeys.settings, {
      ...current,
      diffHideWhitespace: next,
    });
    // Only the field: the cached snapshot's other fields can be older than disk.
    void save.mutateAsync({ diffHideWhitespace: next }).catch((e: unknown) => {
      toastError(e);
      if (seq !== flipSeq) return;
      const latest = queryClient.getQueryData<AppSettings>(
        settingsKeys.settings,
      );
      if (latest === undefined) return;
      // Only this field: a concurrent settings change keeps its own value.
      queryClient.setQueryData(settingsKeys.settings, {
        ...latest,
        diffHideWhitespace: previous,
      });
    });
  };
}
