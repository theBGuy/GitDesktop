import { useQuery } from "@tanstack/react-query";
import { detectContainerSandbox } from "./sandbox";

/**
 * Container-sandbox readiness for one image config (Node base version + the agent
 * CLIs baked in). Shared by Settings → AI and the session composer's Isolation row
 * so the two read ONE cached probe instead of each shelling out to Docker/Podman —
 * the query key is the config, so a build/rebuild invalidating
 * `["agentContainerStatus"]` refreshes both.
 *
 * `enabled` is the caller's gate: Settings probes only while the container option
 * is on, the composer only while a NEW session is actually set to run in one (and
 * its tab is showing — an `<Activity>`-hidden subtree still fetches).
 */
export function useContainerStatus({
  nodeVersion,
  providers,
  enabled,
}: {
  nodeVersion: string;
  providers: string[];
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [
      "agentContainerStatus",
      nodeVersion,
      [...providers].sort().join(","),
    ],
    queryFn: () => detectContainerSandbox(nodeVersion, providers),
    staleTime: 30_000,
    enabled,
  });
}
