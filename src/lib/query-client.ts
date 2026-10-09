import { onlineManager, QueryClient } from "@tanstack/react-query";
import { installAccountChangeReset } from "./account-change";
import { shouldParkOnOffline } from "./offline-park";

// Module-level so non-React code (e.g. the automations runner) can
// invalidate queries after background work lands.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Going offline triggers nothing in react-query, so settled errors are parked
// here; `shouldParkOnOffline` names the queries that must not be.
onlineManager.subscribe((online) => {
  if (!online)
    void queryClient.refetchQueries({
      type: "active",
      predicate: shouldParkOnOffline,
    });
});

// A forge account change resets the forge caches (account-change.ts). The
// sources-probe key is spelled here rather than imported: MY_WORK_SOURCES_KEY
// lives in git/queries/forge-repos.ts, which would pull the query layer in.
installAccountChangeReset(queryClient, {
  invalidateKeys: [["bb-account"], ["my-work-sources"]],
});
