import { onlineManager, QueryClient } from "@tanstack/react-query";
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
