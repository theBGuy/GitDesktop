import { useQuery } from "@tanstack/react-query";
import { useSettings } from "@/lib/settings/queries";
import { checkForUpdate } from "@/lib/updater";

/** ~6h cadence: a desktop app that's never closed still learns about a release
 *  the same day. Focus-refetch (global default) re-checks after ≥1h away, which
 *  also covers laptop sleep pausing the interval timer. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function useUpdateCheck() {
  const settings = useSettings();
  const auto = settings.data ? (settings.data.autoCheckUpdates ?? true) : false;
  return useQuery({
    queryKey: ["app-update"] as const,
    queryFn: checkForUpdate,
    enabled: auto,
    refetchInterval: CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true, // the app sits unfocused for days — poll anyway
    staleTime: 60 * 60 * 1000,
    retry: false, // offline / no release yet — stay quiet, next tick retries anyway
    // LOAD-BEARING: Update is a plugin class instance (download/install live on
    // the prototype). react-query's default structural sharing clones result data
    // into plain objects, which would strip the method and break Install.
    structuralSharing: false,
  });
}
