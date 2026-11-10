import { useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/toast";
import type { AppSettings } from "./api";
import { settingsKeys, useSaveSettingsPatch, useSettings } from "./queries";

/** Bumped by every flip, so a late rejection of an older write never rolls
 *  back a newer one. */
let flipSeq = 0;
/** Flips whose write hasn't settled yet. */
let inFlight = 0;
/** The value nothing pending has written over: disk's, since writes ride the
 *  serialized settings chain and land in flip order. A rollback restores this,
 *  never the previous optimistic value, which two failing flips would strand. */
let settled: boolean | null = null;

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
    // With nothing pending, the cache holds disk's value.
    if (inFlight === 0) settled = previous;
    const seq = ++flipSeq;
    inFlight++;
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
    // A rejection restores synchronously, so the gear's focus hand-off rides the
    // same commit; any owed settings refetch lands disk's value, which it matches.
    void save
      .mutateAsync({ diffHideWhitespace: next })
      .then(
        () => {
          settled = next;
        },
        (e: unknown) => {
          toastError(e);
          if (seq !== flipSeq) return;
          const latest = queryClient.getQueryData<AppSettings>(
            settingsKeys.settings,
          );
          if (latest === undefined) return;
          // Only this field: a concurrent settings change keeps its own value.
          queryClient.setQueryData(settingsKeys.settings, {
            ...latest,
            diffHideWhitespace: settled ?? previous,
          });
        },
      )
      .finally(() => {
        inFlight--;
      });
  };
}
