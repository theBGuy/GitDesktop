import { deleteMcpSecret, setMcpSecret } from "@/lib/git/api";
import type { McpSecretDelete, McpStagedSecret } from "./secret-ops";

// The MCP keychain guard pins this code and lets only SettingsScreen's Save run
// it: an edit here re-points MCP_FLUSH_MODULE in the same change.

/** Writes each staged value in turn and returns the entries that failed — the
 *  input objects themselves, which the settle matches by identity. Never throws:
 *  each await sits in its own try/catch, which also contains a sync throw. */
export async function flushMcpSecretSets(
  sets: readonly McpStagedSecret[],
): Promise<McpStagedSecret[]> {
  const failed: McpStagedSecret[] = [];
  for (const entry of sets) {
    try {
      await setMcpSecret(entry.serverId, entry.key, entry.value);
    } catch {
      failed.push(entry);
    }
  }
  return failed;
}

/** Fires each delete without waiting. A failed delete leaves an orphaned
 *  keychain entry at worst, and deleting a missing entry succeeds. */
export function flushMcpSecretDeletes(
  deletes: readonly McpSecretDelete[],
): void {
  for (const { serverId, key } of deletes)
    void (async () => deleteMcpSecret(serverId, key))().catch(() => undefined);
}
