import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { useSettings } from "@/lib/settings/queries";
import { checkForUpdate, type Update } from "@/lib/updater";

/** ~6h cadence: a desktop app that's never closed still learns about a release
 *  the same day. Focus-refetch (global default) re-checks after ≥1h away, which
 *  also covers laptop sleep pausing the interval timer. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_KEY = ["app-update"] as const;

/** A re-check finding the SAME version keeps the cached instance and closes the
 *  fresh one, which nothing else has seen: the cached one may hold a download a
 *  declined install kept, and a new instance would download it all again. A NEW
 *  version replaces it, but the old instance stays open, since an earlier offer
 *  toast may still hold it. */
async function checkKeepingInstance(): Promise<Update | null> {
  const fresh = await checkForUpdate();
  const cached = queryClient.getQueryData<Update | null>(UPDATE_KEY);
  if (fresh && cached && fresh.version === cached.version) {
    void fresh.close().catch(() => undefined);
    return cached;
  }
  return fresh;
}

export function useUpdateCheck() {
  const settings = useSettings();
  const auto = settings.data ? (settings.data.autoCheckUpdates ?? true) : false;
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: checkKeepingInstance,
    enabled: auto,
    refetchInterval: CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true, // the app sits unfocused for days — poll anyway
    staleTime: 60 * 60 * 1000,
    retry: false, // offline / no release yet — stay quiet, next tick retries anyway
    // LOAD-BEARING: Update is a plugin class instance (download/install live on
    // the prototype). react-query's default structural sharing clones result data
    // into plain objects, which would strip them and break Install.
    structuralSharing: false,
  });
}
