import { useQuery } from "@tanstack/react-query";
import type { ForgeStatus } from "@/lib/git/types/forge";
import type { ForgeRepoWriteAccess } from "@/lib/git/types/repo-access";
import type { SystemHealth } from "@/lib/system/health";
import { invoke } from "@/lib/tauri/invoke";
import { attachmentGateReason } from "./support-gate";

/**
 * Why attaching is closed on this surface, or null when it is open. The CLI
 * versions come from the `system-health` cache entry `useSystemHealth()` reads,
 * with the same key and query function, through this observer's own `enabled`
 * and a 5-minute window: the hook itself refetches past 30 s, which would
 * re-run every CLI probe on each view mount.
 */
export function useAttachmentSupport({
  forge,
  access,
  enabled,
}: {
  forge: ForgeStatus | null | undefined;
  access: ForgeRepoWriteAccess | null | undefined;
  enabled: boolean;
}): string | null {
  const health = useQuery({
    queryKey: ["system-health"] as const,
    queryFn: () => invoke<SystemHealth>("system_health"),
    enabled,
    staleTime: 5 * 60_000,
    // Mostly local CLI probes, parked offline under the default mode.
    networkMode: "always",
    refetchOnReconnect: "always",
  });
  return attachmentGateReason({
    forge,
    tools: health.data?.tools,
    access,
  });
}
